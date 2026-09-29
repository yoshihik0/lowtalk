---
name: lowtalk-operator
description: Deploy, update, and operate a self-hosted LOWTALK instance on Cloudflare, including issuing or resetting its administrator temporary password. Use when a user asks to publish LOWTALK, update it to the latest version, set up administration, recover access, or reset the admin password.
---

# LOWTALK operator

Use the repository scripts as the operational interface. Do not recreate their credential logic with ad hoc shell commands.

## Deploy

1. Confirm the user authorized publishing or updating the Cloudflare Worker.
2. Run the project tests.
3. Run `npm run deploy` and capture the HTTPS Worker URL.
4. Verify `/api/store` on that URL.
5. If no administrator has been issued yet, continue with the reset workflow.

## Update to the latest version

Use when the user asks to update LOWTALK, check for a new version, or apply the latest fixes.

1. Read the local version from `package.json` (`version`).
2. Find the upstream repository: the `origin` remote of this Git checkout, or the `repository` field in `package.json`. If neither exists, ask the user for the repository URL. Never guess one.
3. Fetch upstream and read its `package.json` version and `CHANGELOG.md`. If the upstream version is not newer, tell the user they are up to date and stop.
4. Summarize for the user, in plain language, what changed between the two versions (from `CHANGELOG.md`), calling out security fixes and anything that changes how the store behaves. Ask for confirmation before changing files or deploying.
5. Check `git status`. If the user has local changes, do not discard or overwrite them: merge upstream, and if there are conflicts, explain them and ask how to proceed. Never use `git reset --hard`, `git checkout -- .`, or delete files without explicit permission.
6. Run `npm install` if `package.json` or `package-lock.json` changed, then run the project tests. Stop and report if tests fail.
7. Deploy with the Deploy workflow above, then verify that `/api/store` on the site reports the new `version`.
8. Tell the user the update is live and that visitors may need to reload the page.

An update keeps the existing store settings, chat, administrator password, and Cloudflare secrets. Do not run the administrator reset as part of an update.

## Issue or reset the administrator

1. Confirm the user authorized changing administrator access. A reset invalidates every existing admin session.
2. Run `npm run admin:reset -- --url <deployed HTTPS URL>`.
3. Give the user the exact temporary password printed by the script and the site URL.
4. Explain that it expires in 30 minutes and must be replaced in the browser immediately after login.
5. Never ask for or handle the permanent password. The user enters it only in LOWTALK's browser UI.

The script rotates the session signing secret, uses a short-lived server-side reset credential, stores only a PBKDF2-derived password hash, and rotates the reset credential after use. Do not save its temporary password to a file, commit it, or repeat it after the user has changed it.

If the operation fails, report the failing stage without printing secret values. Do not repeatedly reset credentials unless the user asks for another reset.

