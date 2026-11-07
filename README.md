# FMGE Baseline — installable PWA

A self-paced 300-question FMGE baseline exam that installs on your iPhone Home Screen, works offline, and saves every answer on your device.

## Read this first: your data

- Progress is stored in your browser's **IndexedDB** (with a second copy in localStorage). It is **not permanent**. Clearing website data, deleting the Home Screen app, or changing the site's web address can erase it.
- **Never change the address after you start.** Browser storage belongs to the exact web address (for example `https://yourname.github.io`). Pick your GitHub username and repository name carefully before the first exam session. If you rename either, your saved progress will not follow.
- **iPhone keeps Safari and the Home Screen app separate.** Install first, then do the whole exam from the Home Screen icon.
- **Back up regularly** (Settings → Back up progress). Save the file to Files/iCloud or email it to yourself.

## Deploy with GitHub Pages (free)

1. Create a free account at github.com. Choose a username you will keep.
2. Click **+ → New repository**. Name it e.g. `fmge-baseline`. Set it to **Public** (free Pages needs this). Click **Create repository**.
3. Click **uploading an existing file**. Unzip this package on your computer and drag **everything inside the folder** (including the `icons` folder and the `.nojekyll` file if visible) into the page. Click **Commit changes**. `index.html` must sit at the top level of the repository.
4. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
5. Wait 1–2 minutes. Your address will be `https://YOURNAME.github.io/fmge-baseline/`. GitHub Pages serves it over HTTPS, which the offline feature requires.

(Cloudflare Pages also works: create a project, upload this folder, no build command.)

## Install on iPhone

1. Open your address in **Safari**. Let it load fully once while online (this caches the app for offline use).
2. Tap **Share → Add to Home Screen → Add**.
3. Close Safari. Launch **FMGE Baseline** from the Home Screen. It opens full screen with no Safari bars.

## Check that progress is saved

1. Open the Exam, answer two questions, type a note, tap Mark for review.
2. The top chip should say **Saved** with a time.
3. Swipe the app away completely, reopen it. You should land on the same question with answers, note and mark intact.
4. Turn on Airplane Mode and reopen the app. It should still work.

## Back up and restore

- **Back up:** Settings → *Back up progress (JSON)* → **Share / Save to Files** (or Download file). Do this after each study session.
- **Restore:** Settings → *Choose backup file…* (or paste the text) → review the summary → *Replace my progress*. A safety copy of your current progress is saved first.
- Restoring is also how you move progress to a new phone or back from a different web address.

## Safeguards

- Submitting needs you to type `SUBMIT`. Erasing needs `RESET`. Both take an automatic safety copy first (Settings → *Restore last safety copy*).
- Correct answers and explanations are not loaded until you submit.
- Leaving the app never submits the exam.

## Updating the app later

Replace the files in the repository, and change `VERSION` in `sw.js` (e.g. `fmge-baseline-v4.0.1`). Open the app online; an "Update now" bar appears. Your data is untouched; the app migrates stored data by schema version.

## Known limits

- Question 125 has empty answer options in the source data, so it can't be answered and is excluded from scoring (maximum score 299).
- 19 questions mention a diagram; the figure itself is not in the data. The source PDF link needs internet.
- No topic field exists in the source; type topics per question to enable topic-wise analytics.
- Diagnosis/management/investigation analytics are detected from wording (heuristic) and cover about 27% of questions.
- The PDF re-import from the original app was removed: it would overwrite the verified question bank, answer keys and explanations.
