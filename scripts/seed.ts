/**
 * Seeds a Freshdesk trial with realistic merchant tickets so the connector
 * has something to triage. Idempotent-ish: skips if a ticket with the same
 * subject already exists. Uses the same env vars as the connector.
 */
import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const domain = process.env.FRESHDESK_DOMAIN?.replace(/\.freshdesk\.com$/, "");
const key = process.env.FRESHDESK_API_KEY;
if (!domain || !key) throw new Error("Set FRESHDESK_DOMAIN and FRESHDESK_API_KEY in .env");

const base = `https://${domain}.freshdesk.com/api/v2`;
const headers = {
  Authorization: "Basic " + Buffer.from(`${key}:X`).toString("base64"),
  "Content-Type": "application/json",
};

// priority: 1 low, 2 medium, 3 high, 4 urgent. status 2 = open, 3 = pending.
const tickets = [
  { email: "rahul.m@example.com", subject: "Autopay failed again — am I still subscribed?", priority: 3, status: 2, tags: ["autopay", "subscription"], type: "Question",
    description: "Hi, my monthly plan payment failed on 28 Oct. I got an SMS saying the mandate was declined. My card is 4111 1111 1111 1111 and my number is +91 98765 43210. Has my subscription been cancelled? I can't see any way to retry the payment from the app." },
  { email: "priya.s@example.com", subject: "Mandate declined, SMS said insufficient funds but I have balance", priority: 4, status: 2, tags: ["autopay"], type: "Problem",
    description: "The UPI autopay for my subscription was declined this morning with 'insufficient funds'. I have more than enough balance. This is the second month this has happened. Please fix or I will cancel." },
  { email: "arjun.k@example.com", subject: "Charged twice after autopay retry", priority: 4, status: 2, tags: ["autopay", "refund"], type: "Problem",
    description: "My autopay failed on the 1st, then succeeded on a retry on the 2nd, and now I see TWO debits of Rs 999 in my bank statement. I want the duplicate reversed immediately." },
  { email: "sneha.r@example.com", subject: "Refund not received for order #88412", priority: 3, status: 3, tags: ["refund"], type: "Question",
    description: "Refund was approved on 20 Oct per your email. Still nothing in my account after 10 days. Reference number RZP-REF-88412." },
  { email: "vikram.d@example.com", subject: "Want to cancel my subscription", priority: 1, status: 2, tags: ["subscription"], type: "Question",
    description: "Please cancel my monthly plan from next cycle. I don't want to be charged again. Confirm when done." },
  { email: "meera.n@example.com", subject: "COD order returned, when do I get my money?", priority: 2, status: 2, tags: ["refund", "cod"], type: "Question",
    description: "I returned my cash-on-delivery order last week. The pickup happened on 26 Oct. How and when will I get the Rs 2,450 back?" },
  { email: "karan.b@example.com", subject: "Can't update card on file for autopay", priority: 2, status: 2, tags: ["autopay"], type: "Problem",
    description: "My old card expired. The app shows 'update payment method' but the button does nothing. Autopay will fail next week if I can't change it." },
  { email: "ananya.t@example.com", subject: "Order delayed, no tracking update since 3 days", priority: 1, status: 2, tags: ["shipping"], type: "Question",
    description: "Order #90213 shows 'shipped' but tracking hasn't moved since Thursday. Where is it?" },
];

async function existingSubjects(): Promise<Set<string>> {
  const res = await fetch(`${base}/tickets?per_page=100`, { headers });
  if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as Array<{ subject: string }>;
  return new Set(rows.map((r) => r.subject));
}

async function main() {
  const have = await existingSubjects();
  let created = 0;
  for (const t of tickets) {
    if (have.has(t.subject)) { console.log(`skip   ${t.subject}`); continue; }
    const res = await fetch(`${base}/tickets`, { method: "POST", headers, body: JSON.stringify(t) });
    const body = await res.text();
    if (!res.ok) { console.error(`FAIL   ${t.subject}\n       ${res.status} ${body}`); continue; }
    const id = (JSON.parse(body) as { id: number }).id;
    console.log(`create #${id}  ${t.subject}`);
    created++;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`\n${created} created, ${tickets.length - created} skipped`);
}

main().catch((e) => { console.error(e); process.exit(1); });
