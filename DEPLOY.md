# Deploying RTO Shield

About 20 minutes. Everything runs in your browser: you don't need to install anything on your laptop.

## 1. Put the code on GitHub (public)

1. Go to https://github.com/new, name the repo `rto-shield`, choose **Public**, and click **Create repository**. Don't add a README.
2. On the empty repo page, click **uploading an existing file**.
3. Open the `rto-shield` folder on your computer, select **everything inside it** (`server.js`, `package.json`, `Dockerfile`, `README.md`, `DEPLOY.md`, and the `server`, `public` and `docs` folders), and drag it all onto the page.
4. Click **Commit changes**.

Only upload the `rto-shield` folder's contents. Don't upload the other files in `ai_builder_hackathon`.

## 2. Open Cloud Shell

1. Go to https://console.cloud.google.com and pick your project at the top. Create one if you haven't, and make sure billing is linked.
2. Click the **Activate Cloud Shell** icon (`>_`) at the top right. A terminal opens at the bottom of the page.

## 3. Set up the project (one time)

Paste these commands one block at a time. Replace `YOUR_PROJECT_ID`.

```bash
gcloud config set project YOUR_PROJECT_ID

gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com generativelanguage.googleapis.com

gcloud firestore databases create --location=asia-south1
```

If the last command says a database already exists, that's fine.

Let Cloud Run's service account read and write Firestore:

```bash
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $(gcloud config get-value project) \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/datastore.user"
```

## 4. Get a Gemini API key

Go to https://aistudio.google.com/apikey → **Create API key** → choose your project. Copy the key. Keep it out of GitHub, chat and the video.

## 5. Deploy

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/rto-shield.git
cd rto-shield

gcloud run deploy rto-shield --source . --region asia-south1 \
  --allow-unauthenticated --max-instances 1 \
  --set-env-vars GEMINI_API_KEY=PASTE_YOUR_KEY
```

- If it asks to create an Artifact Registry repository, answer **Y**.
- The first build takes 3–5 minutes. At the end it prints a **Service URL** like `https://rto-shield-xxxxx.asia-south1.run.app`. That's your prototype link.

## 6. Check it works

Open the Service URL in an **incognito window**:

- The header shows **Gemini ready** and **Firestore connected**. If Firestore says "local", repeat the permission command in step 3 and redeploy.
- Open order **ORD-1042** → **Call with Gemini** → **Start voice call**, and allow the microphone. Riya should greet you within a few seconds. Use headphones.
- Open order **ORD-1043** → **Prepaid offer**. A WhatsApp draft should appear.
- Open **Impact**: the numbers and the recent activity list should be there.

## If the voice call doesn't start

The app shows the exact error. Common fixes:

- **Model not found:** the Live model name changed. Check the current one at https://ai.google.dev/gemini-api/docs/live and redeploy with `--update-env-vars LIVE_MODEL=<name>`.
- **Token error mentioning the API version:** redeploy with `--update-env-vars LIVE_API_VERSION=v1alpha`.
- **Microphone blocked:** allow it in the browser's address bar, or use **Use text instead**. That runs the same agent by text, and the call is analysed the same way.

To update after code changes: upload the changed files to GitHub, then in Cloud Shell run `cd rto-shield && git pull` and the same `gcloud run deploy` command (the key is kept, so you can drop `--set-env-vars`).

## Keep it running until 6 Nov

Judging runs 19 Oct – 6 Nov. Don't delete the service, the project or the API key, and keep billing active. With `--max-instances 1` and no minimum instances, cost while idle is close to zero.
