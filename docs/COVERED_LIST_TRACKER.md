# Updating the FCC Covered List robot tracker

The tracker page (`/tools/covered-list-robots/`) is updated **manually**. Nothing fetches FCC data automatically:
fcc.gov blocks automated requests, and every entry should be checked by a person before it is published.

All content lives in one file: [`web/public/data/covered-list-robots.json`](../web/public/data/covered-list-robots.json).

## When to check

- When a news brief or law-firm alert mentions a new robotics conditional approval.
- About once a week, open the official list: <https://www.fcc.gov/supplychain/coveredlist>. Its "Robotic Devices
  Conditional Approvals" table (Appendix B of each new Public Notice) lists every approval with its date.

## Adding or verifying an entry

1. Download the Public Notice PDF from FCC EDOCS (for example `DA-26-996A1.pdf`). Keep it in the project root; PDF
   files are git-ignored everywhere in the repository and are never committed.
2. Add or edit the entry in the JSON file:
   - `id`: short lowercase name, letters, digits and hyphens (for example `acme-x100`). Must be unique.
   - `manufacturer`, `equipment` (list the models exactly as the FCC names them), `category`, `status`.
   - `notice_number` (for example `DA 26-1114`) and `date_announced` (`YYYY-MM-DD`).
   - `conditions_summary`: quote or closely paraphrase the notice. Don't add interpretation.
   - `primary_source_url`: the FCC PDF link (`https://docs.fcc.gov/public/attachments/DA-26-XXXXA1.pdf`).
   - `secondary_sources`: optional list of `https://` links (press releases, law-firm notes).
   - `verified_against_primary`: `true` only after every field has been checked against the FCC notice.
   - `last_checked`: the date you checked it.
3. Set the top-level `last_updated` to today.
4. Run the checks: `cd web`, then `npm test`. The test suite rejects malformed entries, duplicate IDs, bad dates and
   non-https links. The page also refuses to show data that fails validation.
5. Commit, then deploy when approved.

## Scope

List robotic-device approvals only. Routers, drones (UAS) and power inverters appear in the same notices but are out of
scope. Keep the disclaimer text unchanged unless it has been reviewed.
