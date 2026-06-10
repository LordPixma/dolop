# M&A migration runbook

A practical sequence for moving an acquired organisation from tenant A (source) to tenant B
(destination) with minimal user disruption. Mirrors the BitTitan pre-stage/cutover pattern.

## T-minus 2–4 weeks — prepare

1. **Connectors**: register the Entra apps ([setup.md](setup.md)), add both connectors, **Verify**.
2. **Project**: create it, assign connectors, set **concurrency** in Settings
   (start at 10; Graph throttling is handled automatically, but going far above ~30–50
   concurrent mailboxes mostly just trades throughput between users).
3. **Scope users**: *Users → Discover & add* (auto-map UPNs to the new domain) or import a
   CSV mapping (`source@old.com,dest@new.com`) for non-trivial naming changes.
4. **Assessment pass**: *Start a pass → Assessment*. Review per-user mailbox item counts,
   OneDrive bytes, and `dest_user_missing` / `dest_mailbox_missing` findings in Errors.
5. **Provision**: select unprovisioned users → *Provision selected* → choose usage location +
   licenses. Export the one-time passwords screen immediately (shown once).
   Wait for Exchange mailboxes to finish provisioning (minutes to an hour after licensing).
   OneDrive sites provision on first sign-in — have users (or a script) hit
   `https://<tenant>-my.sharepoint.com` once, or pre-provision via SharePoint admin.

## T-minus 1–2 weeks — pre-stage

6. **Pre-stage pass**: *Start a pass → Pre-stage*, cutoff = ~7 days ago, workloads: Mail
   (+ OneDrive if you want bulk files early). This moves the heavy history while users keep
   working in the source tenant.
7. Watch the Users tab; triage the Errors tab. Item errors don't stop a mailbox — fix root
   causes (permissions, licensing) and they'll be retried by the next pass.
8. Optionally enable **automatic delta sync** in Settings to keep tenants converged.

## Cutover weekend

9. **Final full pass**: *Start a pass → Full* with all workloads. Thanks to the id map and
   delta tokens this only copies what pre-stage didn't.
10. **DNS/MX cutover**: repoint MX, SPF/DKIM/DMARC, Autodiscover to the destination tenant.
    (If the SMTP domain itself moves tenants, remove it from the source tenant and attach it
    to the destination, then update UPNs/proxy addresses — plan this carefully; it is the one
    genuinely disruptive step in any tenant-to-tenant migration.)
11. **Final delta pass** after mail flow switches, catching anything delivered during the
    change window. Run Rules & settings last so auto-replies/rules land after mailboxes are
    complete.
12. **Reports**: download the user + error CSVs (also archived in R2) for the project record.

## Aftercare

- Keep auto-delta on for a few days for stragglers, then disable it and archive the project.
- Reconfigure Outlook/OneDrive clients (the equivalent of BitTitan DeploymentPro) with
  Intune/Autopilot or documented manual steps — see
  [bittitan-parity.md](bittitan-parity.md) for what client-side work remains.
