# Connect your Google Workspace mailbox

This guide is for the administrator of your organization's Google Workspace. It takes
about 15 minutes and is done once. At the end you will paste two values (a client ID and
a client secret) into the application, then sign in as the mailbox that should send mail.

You need a Google Workspace administrator account. A personal `@gmail.com` account
cannot use the **Internal** setting in step 3.

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com> and sign in as a Workspace administrator.
2. Open the project picker at the top and choose **New project**.
3. Name it (for example "Careers email") and make sure the **Organization** is your
   company. Choose **Create**.

## 2. Turn on the Gmail API (and the Calendar API)

1. With the new project selected, open **APIs & Services > Library**.
2. Search for **Gmail API**, open it and choose **Enable**.
3. If the application will also book interviews on a calendar, do the same for
   **Google Calendar API**.

## 3. Set up the OAuth consent screen as Internal

1. Open **APIs & Services > OAuth consent screen** (in newer consoles this is
   **Google Auth Platform**).
2. For **User type** choose **Internal**, then **Create**. Internal means only people in
   your organization can approve the connection.
3. Fill in the app name, a support email and a developer contact email. Save.
4. When asked about scopes you can skip the step. The application asks for the
   permission it needs when you connect.

> **Warning: do not leave the app in "Testing".**
> If your consent screen is External with publishing status **Testing**, Google
> expires every connection after **7 days** and sending stops until someone
> reconnects. Use **Internal**. If you cannot (for example, an External app is
> required), set the publishing status to **In production**.

## 4. Create a Web OAuth client

1. Open **APIs & Services > Credentials** and choose **Create credentials >
   OAuth client ID**.
2. For **Application type** choose **Web application** and give it a name.
3. Under **Authorized redirect URIs** choose **Add URI** and paste the callback URL
   shown in the application's Google settings page. It looks like
   `https://app.example.com/api/google/callback`. It must match exactly, including
   `https://` and with no trailing slash unless the application shows one.
4. Choose **Create**.
5. Google shows a **Client ID** (ending in `.apps.googleusercontent.com`) and a
   **Client secret**. Keep this window open or download the JSON.

## 5. Paste the values into the application

1. In the application, open the Google settings page for your organization.
2. Paste the **Client ID** and **Client secret** and save. The secret is encrypted and
   is never shown again. Only its last few characters are displayed.
3. Choose **Connect**, sign in as the mailbox that should send email (for example
   `careers@yourcompany.com`), and approve the request to **send email on your behalf**. If calendar booking is
   enabled, you are also asked to **manage events on calendars you own** and to **see
   free/busy information**. A mailbox that was connected for email only must go through
   Connect again to add the calendar permissions.

If you see "wrong account", you signed in with a different mailbox than the one the
application expected. Choose Connect again and select the right one.

## Good to know

- **Disconnecting.** Use the application's Disconnect button. Anyone can also remove access
  at <https://myaccount.google.com/permissions>.
- **Changing the client.** Pasting a different client ID disconnects existing
  mailboxes; each one must be connected again. Rotating only the secret does not.
- **Connections that stop working.** If the mailbox's access is revoked, the account is
  suspended, or the app was removed in the admin console, the application marks the
  connection as revoked and asks you to reconnect.
- **Reconnecting often.** Google keeps a limited number of active sign-ins per account
  and client. Reconnecting many times can silently invalidate the oldest ones.
- **Calendar free/busy.** For the application to suggest meeting times, your Workspace
  must let people see each other's free/busy. In the Admin console open **Apps > Google
  Workspace > Calendar > Sharing settings** and share at least free/busy within your
  organization. Colleagues who are not visible show as "unknown" and no times are
  suggested for them. See the [calendar guide](./calendar-scheduling.md).
- **Sending limits.** Google limits how many emails a mailbox can send per day
  (Workspace accounts have a higher limit than personal accounts).
