# Redundancy nodes

ASPECTenant can run on several machines at once. All of them use one external PostgreSQL database, so every node sees the same mailboxes, users and settings at the same moment. If one machine stops, the others keep serving and one of them takes over the work that must happen only once.

## How it works

- **Shared database.** All nodes connect to one PostgreSQL 17 database over the internet with TLS (`sslmode=require`), for example a Neon project. Keeping that database redundant and backed up is the provider's job (Neon keeps copies across availability zones and offers point-in-time restore). The panel's own encrypted backups to S3 keep working as well.
- **Every node serves.** The panel, sign-in, the mail app, IMAP and SMTP for mail apps, and inbound mail all work on any node.
- **One leader.** Exactly one node at a time runs the jobs that must happen once:
  - scheduled backups
  - renewal of the mail apps certificate
  - mailbox (PST) imports
  - checks for new releases

  Leadership is a lease row in the database (`aspectenant_cluster_lease`) that the leader renews every 5 seconds. If it is not renewed for 20 seconds, another node takes it. Because the database row is the only arbiter, two nodes can never lead at once.
- **Primary and secondary.** The node installed with role `primary` leads whenever it is up. A secondary takes over when the primary stops. Once the primary is back and has been running for 30 seconds, it gets leadership back.
- **Signals.** Some changes are read only at startup: the public URL, OIDC signing keys, and a restored backup. When one of these changes, the node that made it tells the others through `aspectenant_cluster_signals`, and they restart a few seconds apart. Saving mail apps settings, or issuing a new certificate, makes every node reload its IMAP and SMTP listeners.
- **Imports.** On redundancy nodes, an uploaded PST is stored in the database (`aspectenant_import_chunks`) rather than on one machine's disk, so any node can receive the upload and the leader can run it. The chunks are deleted once the import succeeds.
- **Updates.** The leader asks GitHub for new releases. Every node then updates its own containers through its own updater, within 15 minutes.

The System page lists the nodes for platform operators: role, leader, online state, version and address. Offline machines that were retired can be removed there.

## Message storage in R2 or S3

Most of an installation's database is the original copy of each message, attachments included. Under System, **Message storage**, a platform operator can keep those originals in an S3-compatible bucket instead: Cloudflare R2, Amazon S3, Backblaze B2 or MinIO. The database then holds only the message list, folders, users and settings, which is small enough for a hosted PostgreSQL such as Neon's free plan.

- New mail goes straight to the bucket, under `<folder>/messages/<organisation>/<month>/`. The database row keeps only the key (`raw_key`).
- The leader moves existing messages across in the background, 50 at a time, and shows progress on the panel. Switching back to the database moves them home the same way.
- If the bucket cannot be reached, mail is still delivered. It is kept in the database and moved later.
- Reading is unchanged everywhere: the mail app, IMAP, downloads and forwarding. Each node keeps a small read cache.
- Objects that no message refers to any more, such as deleted mail or a removed mailbox, are deleted after 30 days. A restored backup from the last month still finds its messages. Use a bucket or folder for this installation only.
- Panel backups do not contain messages that live in the bucket. Protect the bucket on its own, with versioning or a bucket backup.

To move to Neon with a large mailbox store: set message storage to R2, wait until the panel shows 0 messages in the database, then run `install.sh` option 4. It compacts the messages table first, so the copy only holds what is left.

## Traffic

- **Panel, mail app and inbound mail.** Run `cloudflared` for the same Cloudflare Tunnel on every node, pointed at that node's panel port. Cloudflare sends traffic to a connector that is up, so no DNS change is needed when a machine stops. The Email Routing Worker posts to the panel URL, so inbound mail follows the tunnel too.
- **Mail apps (IMAP and SMTP).** These ports do not go through the tunnel. Turn on "Move the mail apps hostname to the leading node" under System. When leadership moves, the new leader updates the A (or AAAA) record of the mail apps hostname in Cloudflare to its own `NODE_ADDRESS`. It uses DNS only, with a 60-second TTL, and the Cloudflare token saved under Mail apps. Forward ports 993, 465 and 587 to each machine.

## Setting it up

1. **Create the database.** Create a PostgreSQL 17 database, for example a new Neon project, on a plan with room for your data plus growth (the installer prints your database size and refuses a plan that is too small; Neon's free plan stops at 0.5 to 1 GB). Copy the owner connection string, using the **direct** connection, not the `-pooler` one: migrations need session locks.
2. **Move the first machine onto it.** On the existing installation, run `install.sh` and choose **4**. The installer:
   - checks the connection
   - stops the panel and copies the bundled database (with all mail) into the new one
   - creates a non-superuser application role `aspectenant_app`, so row-level security applies
   - checks that the message counts match
   - starts again as the primary

   The bundled database is left untouched as a fallback, and the copy is kept as `database-<time>.dump` in the installation folder. Delete both once you are satisfied. To go back, remove the `DATABASE_URL` line from `.env` and run `install.sh` with option 2. Changes made in the meantime are not copied back.
3. **Get the join command.** On the first machine, run `install.sh` and choose **6**. It prints a one-line command that contains the database URL and the encryption key. Treat it like a password.
4. **Add a machine.** On each extra machine, run that command as root, or run `install.sh`, choose **5** and paste the join code. The machine joins as a secondary with the same database and keys. It asks for a name and its public IP.
5. **Route traffic.** Add a tunnel connector on each node and turn on mail hostname failover, as described under Traffic.

## Limits

- The external database is the single shared dependency. If it is unreachable, every node stops serving until it returns. Choose a provider and region you trust, and keep S3 backups on.
- Node clocks must be correct (NTP), because lease times use each node's clock.
- Sign-in rate limits and the IMAP and SMTP lockout are counted per node.
- Neon's scale-to-zero never triggers, because the heartbeats keep the database busy. Budget for an always-on compute.
