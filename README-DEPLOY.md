# Deploying Mentour Suite to Hostinger

This is a normal Node.js + MySQL web app. It was built and tested locally
against a real MySQL database before being handed to you (see `tests/`) —
the steps below are just about getting those same files running on
Hostinger's Node.js hosting.

You'll need a Hostinger plan that includes Node.js apps (Business Web
Hosting or any Cloud hosting plan — not available on the base Single Shared
Hosting plan).

---

## 1. Create the MySQL database

1. In **hPanel**, go to **Websites → [your site] → Databases → Management**.
2. Fill in a database name, a database username, and a password. Click
   **Create**, and save the password somewhere safe — Hostinger won't show
   it again.
3. Note the three values: database name, username, password. The host is
   almost always `localhost` on Hostinger (the app and database run on the
   same machine), which is why `.env.example` defaults `DB_HOST` to that.

You do **not** need to enable "Remote MySQL" — that's only for connecting
from *outside* Hostinger (e.g. your laptop). The app talks to the database
from the same server, so it just needs `localhost`.

## 2. Prepare the project for upload

On your own computer:

1. Make sure `node_modules/` and `.env` are **not** included in what you
   upload (`.gitignore` already excludes both if you use Git).
2. Zip the project folder: `package.json`, `package-lock.json`, `server.js`,
   `src/`, `public/`, `db/`, `scripts/`, `.env.example`.

## 3. Deploy the Node.js app

1. In hPanel: **Websites → Add Website → Node.js web app** (also labeled
   "Deploy Web App" in some accounts).
2. Choose **Upload your files**, and upload the `.zip` from step 2 — or
   choose **Import Git repository** if you'd rather push this to a GitHub
   repo first and deploy from there (this also gives you auto-redeploy on
   every push, which is convenient later).
3. Hostinger will detect it's a Node app from `package.json`. Confirm:
   - **Application root**: the folder containing `package.json`
   - **Entry file / startup file**: `server.js`
   - **Node version**: 18 or newer
   - **Install/build command**: default (`npm install`) is fine — there's
     no separate build step.
4. Don't click Deploy yet — first add the environment variables in the next
   step (there's a spot for this on the same screen, or you can add them
   after deploying and redeploy).

## 4. Set environment variables

Either on the deploy screen, or afterward via **your site's dashboard →
Environment variables**, add:

| Key | Value |
|---|---|
| `DB_HOST` | `localhost` |
| `DB_PORT` | `3306` |
| `DB_NAME` | the database name from step 1 |
| `DB_USER` | the database username from step 1 |
| `DB_PASSWORD` | the database password from step 1 |
| `SESSION_SECRET` | a long random string (see below) |
| `NODE_ENV` | `production` |

Generate a `SESSION_SECRET` once, on your own machine:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Paste the output in as the value. This is what signs login session
cookies — treat it like a password; don't reuse the one from `.env.example`.

You don't need to set `PORT` — Hostinger sets that automatically, and
`server.js` already reads `process.env.PORT`.

Click **Deploy**. Hostinger runs `npm install` and starts the app.

## 5. Create the database tables

The app's tables don't exist yet — the schema needs to run once. Easiest
way, no terminal needed:

1. In hPanel, open **Databases → phpMyAdmin** and select your database.
2. Go to the **Import** tab, choose the `db/schema.sql` file from this
   project, and run it.

(If your plan gives you SSH/terminal access to the app, you can instead run
`npm run init-db` from the project folder — it does the same thing.)

## 6. Point your domain at it

If you're using a domain you already have on Hostinger, attach it to this
website from **Websites → [your site] → Domain**. Hostinger issues a free
SSL certificate automatically — give it a few minutes after attaching the
domain, then confirm the site loads over `https://`.

## 7. First login

Visit your domain. You'll land on the sign-in page — there's no account
yet, so click **Create an account**, choose **New company**, and sign up as
Mentour Corp. That first signup becomes the account **owner**. From the
home page afterward, the owner sees an invite code to share with teammates
(they use **Join with invite code** on the signup page).

Each of the two dashboards (Ledger, Margin) will show the upload screen the
first time — after that first import, they'll auto-load whatever was last
saved, for anyone signed in to that company.

---

## Redeploying after you change something

- **Git-connected**: push to the branch you deployed from; it redeploys
  automatically.
- **Zip upload**: re-zip and upload again from the site dashboard.

Either way, environment variables and the database persist across
redeploys — you only did steps 1, 4, and 5 once.

## If you outgrow Cloud/Node.js hosting

The "other companies down the line" case is already handled in the data
model — a new company just signs up and creates its own organization; its
data is isolated from Mentour Corp's automatically (this was the main thing
tested before handing this off — see `tests/e2e_test.js`). What Cloud
hosting *won't* give you later is things like background jobs, staged
environments, or per-tenant subdomains — if you get there, that's a VPS
(CloudPanel) conversation, not a rebuild.

## Security notes

- Passwords are hashed with bcrypt before storage — the database never
  holds a plain password.
- Every data query is scoped by `organization_id`, enforced server-side,
  not just hidden in the UI — a signed-in user literally cannot query
  another company's data through this API, confirmed in `tests/e2e_test.js`.
- Login and signup are rate-limited (20 attempts per 15 minutes per IP) to
  slow down brute-force guessing.
- `SESSION_SECRET` and database credentials live only in environment
  variables — never commit a real `.env` file.
