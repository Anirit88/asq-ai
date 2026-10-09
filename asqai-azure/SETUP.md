# ASQAi 2.0 on Azure: setup guide

This version adds:

- **Your own sign-in.** Patients and the care team sign in with email and password, so outside users don't need a Microsoft or GitHub account. Microsoft and GitHub stay as optional buttons.
- **Admin view.** Manage users, roles, login pages, the kiosk, settings and the go-live checklist.
- **Lobby kiosk.** A full kiosk at `/kiosk`. Check-ins and walk-ins sync to the doctor's check-in queue.
- **Real doctors nearby.** Location or ZIP search, using the US national provider registry, plus a live OpenStreetMap map.

## What's in this folder

Put everything at the top level of your GitHub repo, replacing the old files.

| File | What it is |
|---|---|
| `index.html` | The app: patient, doctor and admin views, plus the kiosk |
| `login.html` | Your login pages. They are served at `/login`, `/patient` and `/doctor` |
| `staticwebapp.config.json` | Page routes and security headers |
| `api/` | The server code (Azure Functions): accounts, data, kiosk and doctor search |

---

## Step 1. Upload the files to GitHub

1. Unzip `asqai-azure.zip`.
2. In your repo on github.com, click **Add file**, then **Upload files**.
3. Drag in **everything inside** the `asqai-azure` folder: `api`, `index.html`, `login.html`, `staticwebapp.config.json` and `SETUP.md`.
4. Click **Commit changes**.

The `api` folder replaces the old one. If GitHub still shows the old file `api/src/functions/state.js`, open it, click the **⋯** menu, choose **Delete file**, and commit.

## Step 2. Check the workflow file

Open `.github/workflows/azure-static-web-apps-….yml` and make sure these lines are under `with:`:

```yaml
          app_location: "/"
          api_location: "api"
          output_location: ""
          skip_app_build: true
```

## Step 3. Add the settings in Azure

In the Azure portal, open your Static Web App, then go to **Settings**, then **Environment variables**, then the **Production** tab. Add each of these with **+ Add**. When you've added all of them, click **Apply** at the bottom of the page, then **Confirm**.

| Name | Value | Why |
|---|---|---|
| `STORAGE_CONNECTION_STRING` | You already added this | Where all data is saved |
| `ADMIN_EMAIL` | Your email, e.g. `taha.ghadiali@netweb.biz` | Creates the first admin account |
| `ADMIN_PASSWORD` | A temporary password, e.g. `Start-2026!` | Used once. You choose a new one at first sign-in |
| `SESSION_SECRET` | A long random string, 40+ characters | Signs sign-in cookies. Recommended. |

To make a random `SESSION_SECRET`, mash the keyboard for 40+ characters, or use a password generator.

## Step 4. Wait for the deploy

1. In GitHub, open the **Actions** tab.
2. Wait for the green ✅ (about 2–4 minutes).

## Step 5. First sign-in as admin

1. Open `https://<your-app>.azurestaticapps.net/doctor`.
2. Enter your `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then click **Sign in**.
3. Choose your own password when asked. From then on, the `ADMIN_PASSWORD` setting is ignored.
4. You land in the **Admin view**. On **Overview**, click **Platform and data** to see the go-live checklist.

The first time a doctor or admin signs in, an empty clinic is created in your storage. There is no sample data.

## Step 6. Set things up in the Admin view

**Overview**

1. Click **Run check**. "Data storage" should say **Healthy**.

**Users**

1. Click **Add user**, then pick a role:
   - **Doctor**
   - **Admin**
   - **Patient**
   - **Kiosk**, for a lobby tablet
2. You get a **temporary password** to share. The person sets their own password the first time they sign in.
3. Use the buttons on each person's row to:
   - edit them or change their role
   - reset their password
   - disable them (they're signed out everywhere)
   - unlock a locked account
   - delete them (inside **Edit**)

**Intake form**

1. The form is split into sections. It starts with Demographics, Reason for visit, Medical history, Medications and allergies, Insurance and Lifestyle.
2. Rename a section, add a short description, move it up or down, or delete it. Its questions move to the section above.
3. Click **Add section** for a new one, then **Add question to this section**.
4. Each question has a **Section** menu to move it.
5. Click **Publish**. Patients see the new form, with section headings and a section list, right away.

**Sign-in**

1. Edit the headline, text, bullet points, clinic name, support phone and accent color.
2. Choose which sign-in methods are allowed, and whether patients can create their own accounts.
3. **Doctor sign-up clinic code**: click **Generate**, then **Save changes**. Share the code privately with your doctors. On the sign-in page they pick **I am a Doctor** and enter the code to create their own account. Click **Turn off** to stop doctor sign-up.
4. Set password length, how long people stay signed in, and the lockout after failed attempts.
5. Click **Save changes**. The live pages update right away.

**Kiosk**

1. Change the **Staff exit PIN**. The default is 2468.
2. Turn walk-ins, insurance photo, vitals and consent on or off.
3. Choose the kiosk languages.

**Platform and data** (button on Overview)

1. See the go-live checklist and storage details.
2. Use the export buttons to download all data, the user list or the audit log.

## Step 7. Your sign-in links

| Who | Link |
|---|---|
| Patients | `https://<your-app>.azurestaticapps.net/patient` |
| Doctors, admins, kiosks (and doctor sign-up) | `https://<your-app>.azurestaticapps.net/doctor` |
| Lobby tablet | `https://<your-app>.azurestaticapps.net/kiosk` |

## Step 8. Set up the lobby tablet

1. In **Users**, add a user with the role **Kiosk**.
2. On the tablet, open `/kiosk` and sign in with that account.
3. Lock the tablet to the browser:
   - iPad: **Settings**, then **Accessibility**, then **Guided Access**.
   - Android: **Screen pinning**.
4. Staff tap the lock icon at the top right and enter the PIN to restart the kiosk or sign the tablet out.

The kiosk resets itself after the inactivity time you set, and after each finished check-in.

---

## How it works

| Part | Details |
|---|---|
| **Accounts** | Stored in your private storage. Passwords are hashed with scrypt and never stored or shown after creation. Sign-in uses a secure, HttpOnly cookie. |
| **Roles and views** | **Patient**: Patient view and Kiosk (they can check themselves in for their own visit). **Doctor** and **Admin**: Doctor view, Admin view and Kiosk. **Kiosk account**: check-in screens only, and it sees just first name, last initial and visit time. |
| **Sign-up** | On the sign-in page, people choose **I am a Patient** or **I am a Doctor**. Patients sign up freely (if allowed). Doctors need the clinic code. Accounts are saved in your storage, so they sign in again with the same email and password. |
| **Doctors patients can book** | Every active doctor account appears in the patient's provider list, with the specialty, fee and experience they enter under **Profile**. |
| **Analytics** | Calculated from your real visits, intakes and check-ins. |
| **Lockout** | After the set number of failed attempts, the account locks for 15 minutes. Admins can unlock it early. |
| **Clinic data** | Schedule, queue, intake records, settings and audit log are shared by the care team. Each patient's own data is private to them. |
| **Doctor search** | Doctors come from the CMS NPI Registry. Practice locations are placed using the US Census geocoder. Clinics, hospitals, map tiles and address search come from OpenStreetMap. All are free with no API key, and only work in the US. |
| **Requests to outside doctors** | Practices found in the search aren't connected to ASQAi, so "Request visit" saves the request in the patient's appointments and shows the office phone number to confirm. |

## Troubleshooting

| Problem | Fix |
|---|---|
| "That email and password do not match" for the admin | Check that `ADMIN_EMAIL` and `ADMIN_PASSWORD` were saved: click **Apply** at the bottom of the page, then **Confirm**. Wait one minute and try again. |
| Overview says Data storage **Error** | `STORAGE_CONNECTION_STRING` is missing or wrong. |
| Doctor search says "did not respond" | The public registry may be busy. Try again, or search by ZIP code. |
| Map is grey | Allow the page to load images from `tile.openstreetmap.org`. Some company networks block it. |
| "Use my location" does nothing | The browser blocked location. Allow it in the browser's site settings, or type a ZIP code. |
| A tablet shows the sign-in page again | The session ended. Raise **Stay signed in for** on the **Sign-in** screen (up to 7 days), then sign the tablet in again. |

## Before using real patient data

This setup is for demos and pilots. For real patient health information you'll need:

- a signed HIPAA BAA with Microsoft
- Microsoft Entra ID for staff sign-in
- private networking for storage
- audit logs sent to Log Analytics
- multi-factor sign-in
- email delivery for password resets
