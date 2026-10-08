# ASQAi on Azure: storage and security setup

What's in this folder (put all of it at the root of your GitHub repo):

| File | What it does |
|---|---|
| `index.html` | The app. When it runs on Azure, it loads and saves each user's data through the API. |
| `login.html` | Sign-in page (Microsoft or GitHub). |
| `staticwebapp.config.json` | Security: everyone must sign in, plus security headers (CSP, HSTS, no framing). |
| `api/` | Azure Function at `/api/state` that saves each user's data as a private JSON file in Blob Storage. |

---

## 1. Create the Storage account (about 3 minutes)

1. Go to Azure Portal, then **Create a resource**, then **Storage account**, then **Create**.
2. On **Basics**:
   - **Resource group:** use the same one as your Static Web App.
   - **Name:** for example `asqaidata` (lowercase letters and numbers only).
   - **Region:** same as your app.
   - **Performance:** Standard.
   - **Redundancy:** LRS (cheapest, fine for a demo).
3. On **Advanced**:
   - **Require secure transfer:** ✅ on.
   - **Allow enabling anonymous access on individual containers:** ❌ off.
   - **Minimum TLS version:** 1.2.
4. Leave **Encryption** at the default (Microsoft-managed keys; data is encrypted at rest).
5. **Review + create**, then **Create**.
6. Open the new storage account, go to **Security + networking**, then **Access keys**, then **Show** next to key1's **Connection string**, and copy it.

You don't need to create a container. The API creates a private `asqai-data` container the first time it saves.

## 2. Give the app the connection string

1. Open your **Static Web App** and go to **Settings**, then **Environment variables** (on older portals it's called **Configuration**).
2. Under **Production**, click **+ Add**:
   - **Name:** `STORAGE_CONNECTION_STRING`
   - **Value:** the connection string you copied.
3. Click **Apply** or **Save**.

The value stays on the server. It never reaches the browser or your GitHub repo.

## 3. Point the GitHub workflow at the API

In your repo, open `.github/workflows/azure-static-web-apps-*.yml` and make the `with:` block look like this:

```yaml
          app_location: "/"
          api_location: "api"
          output_location: ""
          skip_app_build: true
```

Commit. The Actions run builds the API and deploys everything in about 2 minutes.

## 4. Turn on sign-in and roles

Sign-in already works with no setup. Microsoft and GitHub logins are built into Static Web Apps, and `staticwebapp.config.json` blocks every page and the API for anyone not signed in.

**Who can open the Doctor view:** by default, everyone signs in as a patient. To make someone a doctor:

1. Open the Static Web App and go to **Settings**, then **Role management**, then **Invite**.
2. Fill in:
   - **Authorization provider:** Microsoft or GitHub.
   - **Invitee details:** their email (for Microsoft) or username (for GitHub).
   - **Role:** `doctor`.
3. **Generate**, then send them the link. Once they accept, "Switch to Doctor View" works for them. Other users see a message saying they don't have access.

To let only invited people in at all, change `"authenticated"` to `"doctor"` (or a `patient` role you invite people to) in the two `/*` and `/api/*` routes in `staticwebapp.config.json`.

## 5. Check it works

1. Open your `…azurestaticapps.net` URL. You should land on the sign-in page.
2. Sign in, open the account menu (top right), and look for **"● Saved to Azure · time"**.
3. Change something (for example your first name in Profile), then reload. The change should still be there.
4. In the Storage account, open **Storage browser**, then **Blob containers**, then **asqai-data**, then **users**. You'll see one file per user.

## What's protected and how

| Area | Protection |
|---|---|
| Who can reach the app | Every page and the API require sign-in (Microsoft Entra ID or GitHub). |
| Whose data you see | The API identifies the user from a header that Azure sets after sign-in (browsers can't fake it). Each user gets a separate file, named with a one-way hash of their ID. |
| Doctor view | Only users invited with the `doctor` role can open it. |
| Data at rest | Azure Storage encrypts everything automatically. The container is private, with no public access. |
| Data in transit | HTTPS only, TLS 1.2 or higher, and HSTS. |
| Browser hardening | Content-Security-Policy (no outside scripts or connections), no framing (clickjacking), nosniff, and a strict referrer policy. |
| Secrets | The storage key lives only in the app's environment variables, never in code or GitHub. |
| Abuse limits | 2 MB maximum per save; requests that aren't JSON are rejected. |
| Erasing data | `DELETE /api/state` removes the signed-in user's file. |

## Optional extras (cost money or need the Standard plan, about $9/month)

- **Password-protect the whole site** (on top of sign-in): Static Web App, then **Settings**, then **Configuration**, then **Password protection**.
- **Key Vault for the connection string:** keep the secret in Key Vault and reference it from the setting. This needs Standard plus a managed identity.
- **Microsoft Defender for Storage:** malware and anomaly alerts on the storage account.
- **Soft delete for blobs:** Storage account, then **Data management**, then **Data protection**, then turn on soft delete for 7 days. This lets you undo accidental overwrites. It's free apart from the storage it uses.

## Before using real patient data (not now)

This setup is for a demo. Real patient health information (PHI) needs a signed HIPAA BAA with Microsoft, Entra ID only (no GitHub logins), private endpoints, customer-managed keys, audit logging to Log Analytics, a stricter CSP, and a proper database. Plan that as a separate step.
