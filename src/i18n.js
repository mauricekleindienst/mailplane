'use strict';
// UI translations. English is the source language: every key is the English
// text as it appears in the UI, so untranslated strings simply stay English.
// The renderer translates its DOM as it is built (installDomTranslator), main
// uses t() for menus and notifications. To add a language, add an entry to
// LOCALES with the same shape as `de`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MailplaneI18n = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Folder names differ from the action words ("Archive" → Archiv vs. Archivieren)
  const DE_FOLDERS = {
    'Inbox': 'Posteingang', 'Sent': 'Gesendet', 'Drafts': 'Entwürfe', 'Trash': 'Papierkorb',
    'Spam': 'Spam', 'Junk': 'Spam', 'Archive': 'Archiv', 'Starred': 'Markiert', 'All Mail': 'Alle Mails',
    'Snoozed': 'Zurückgestellt', 'All inboxes': 'Alle Posteingänge',
  };

  const DE = {
    // Folders & navigation
    'Inbox': 'Posteingang', 'Sent': 'Gesendet', 'Drafts': 'Entwürfe', 'Trash': 'Papierkorb', 'Spam': 'Spam',
    'Starred': 'Markiert', 'All Mail': 'Alle Mails', 'All inboxes': 'Alle Posteingänge', 'Snoozed': 'Zurückgestellt',
    'Folders': 'Ordner', 'Accounts': 'Konten', 'Messages': 'Nachrichten', 'Message list': 'Nachrichtenliste',
    'Mail': 'Mail', 'Apps': 'Apps', 'Calendar': 'Kalender', 'Calendars': 'Kalender', 'Home': 'Start',
    'Hide sidebar': 'Seitenleiste ausblenden', 'Show sidebar': 'Seitenleiste einblenden',
    
    'Group by thread': 'Nach Konversation gruppieren', 'Refresh': 'Aktualisieren', 'Load more': 'Mehr laden',
    'Inbox categories': 'Posteingangs-Kategorien', 'All': 'Alle', 'People': 'Personen', 'Updates': 'Updates',
    'Newsletters': 'Newsletter', 'Unread': 'Ungelesen', 'Show only unread': 'Nur ungelesene anzeigen',
    'Today': 'Heute', 'Yesterday': 'Gestern', 'Search': 'Suchen', 'Search mail': 'Mails durchsuchen',
    'Search all inboxes': 'Alle Posteingänge durchsuchen', 'Search mail, people and actions…': 'Mails, Personen und Aktionen suchen…',
    'Recent searches': 'Letzte Suchen', 'No matches': 'Keine Treffer', 'Go to': 'Gehe zu', 'Actions': 'Aktionen',
    'Offline': 'Offline', 'Mailbox storage': 'Postfachspeicher',

    // Message actions
    'Reply': 'Antworten', 'Reply All': 'Allen antworten', 'Reply all': 'Allen antworten', 'Forward': 'Weiterleiten',
    'Archive': 'Archivieren', 'Delete': 'Löschen', 'Flag': 'Markieren', 'Unflag': 'Markierung entfernen',
    'Mark Read': 'Als gelesen markieren', 'Mark Unread': 'Als ungelesen markieren',
    'Mark as Read': 'Als gelesen markieren', 'Mark as Unread': 'Als ungelesen markieren',
    'Mark all read': 'Alle als gelesen markieren', 'Archive all': 'Alle archivieren',
    'Mark read / unread': 'Gelesen / ungelesen', 'Star / unstar': 'Markieren / Markierung entfernen',
    'Snooze': 'Zurückstellen', 'Snooze until': 'Zurückstellen bis', 'Snooze failed': 'Zurückstellen fehlgeschlagen',
    'Later today': 'Später heute', 'This evening': 'Heute Abend', 'Tomorrow': 'Morgen', 'This weekend': 'Am Wochenende',
    'Next week': 'Nächste Woche', 'Pick a date &amp; time': 'Datum & Uhrzeit wählen', 'Pick a date & time': 'Datum & Uhrzeit wählen',
    'Pick date & time': 'Datum & Uhrzeit wählen', 'Pick a time in the future': 'Wähle einen Zeitpunkt in der Zukunft',
    'Print': 'Drucken', 'More': 'Mehr', 'Unsubscribe': 'Abbestellen', 'Load Images': 'Bilder laden',
    'Remote images blocked to protect your privacy': 'Externe Bilder wurden zum Schutz deiner Privatsphäre blockiert',
    'Select an email to read': 'Wähle eine Mail zum Lesen', 'Download': 'Herunterladen', 'Saved to Downloads': 'In Downloads gespeichert',
    'Archived': 'Archiviert', 'Deleted': 'Gelöscht', 'Archive failed': 'Archivieren fehlgeschlagen', 'Delete failed': 'Löschen fehlgeschlagen',
    'Marked read': 'Als gelesen markiert', 'Marked unread': 'Als ungelesen markiert', 'Action failed': 'Aktion fehlgeschlagen',
    'Could not update flag': 'Markierung konnte nicht geändert werden', 'Could not update read state': 'Lesestatus konnte nicht geändert werden',
    'Message not found': 'Nachricht nicht gefunden', 'Could not open that message': 'Diese Nachricht konnte nicht geöffnet werden',
    'Could not open print window': 'Druckfenster konnte nicht geöffnet werden', 'Opened unsubscribe page': 'Abmeldeseite geöffnet',
    'Emails can only be moved within the same account': 'Mails können nur innerhalb desselben Kontos verschoben werden',
    'Clear selection': 'Auswahl aufheben', 'Click to copy address': 'Klicken, um die Adresse zu kopieren',
    'BIMI verified sender': 'Per BIMI verifizierter Absender', 'Selected message': 'Ausgewählte Nachricht',
    'Replies': 'Antworten', 'Summary': 'Zusammenfassung', 'Close summary': 'Zusammenfassung schließen',
    'Summarize': 'Zusammenfassen', 'Summarizing…': 'Wird zusammengefasst…',

    // Empty states
    'All caught up': 'Alles erledigt', 'No results': 'Keine Ergebnisse', 'No emails': 'Keine Mails', 'Nothing here': 'Hier ist nichts',
    'Try a different search term.': 'Versuch es mit einem anderen Suchbegriff.', 'Clear search': 'Suche löschen',
    'Something went wrong': 'Etwas ist schiefgelaufen', 'Check your connection and try again.': 'Prüfe deine Verbindung und versuch es noch einmal.',
    'Try again': 'Erneut versuchen', 'New message': 'Neue Nachricht', 'Show everything': 'Alles anzeigen',
    'No drafts. Messages you start and close appear here.': 'Keine Entwürfe. Nachrichten, die du beginnst und schließt, erscheinen hier.',
    'Error loading emails': 'Mails konnten nicht geladen werden', 'Loading…': 'Wird geladen…',
    'Your conversations show up here': 'Hier erscheinen deine Unterhaltungen', 'Add your first account': 'Füge dein erstes Konto hinzu',
    'Mailplane shows saved mail and sends once you\'re back online': 'Mailplane zeigt gespeicherte Mails und sendet, sobald du wieder online bist',

    // Compose
    'New Message': 'Neue Nachricht', 'Edit Message': 'Nachricht bearbeiten', 'Draft': 'Entwurf',
    'To': 'An', 'Cc': 'Cc', 'Bcc': 'Bcc', 'Subject': 'Betreff', 'From': 'Von', 'from': 'von', 'Send from': 'Senden von',
    'Send': 'Senden', 'Send Later': 'Später senden', 'Send later': 'Später senden', 'Schedule': 'Planen', 'Discard': 'Verwerfen',
    'Minimize': 'Minimieren', 'Expand': 'Vergrößern', 'Close': 'Schließen', 'Attach file': 'Datei anhängen',
    'Write your message…': 'Schreib deine Nachricht…', 'Write a message': 'Nachricht schreiben',
    'In 3 hours': 'In 3 Stunden', 'Tonight 8 pm': 'Heute Abend, 20 Uhr', 'Tomorrow 8 am': 'Morgen, 8 Uhr', 'Monday 8 am': 'Montag, 8 Uhr',
    'Bold': 'Fett', 'Italic': 'Kursiv', 'Underline': 'Unterstrichen', 'Strikethrough': 'Durchgestrichen', 'Link': 'Link',
    'Bullet list': 'Aufzählung', 'Numbered list': 'Nummerierte Liste', 'Clear formatting': 'Formatierung entfernen',
    'Text colour': 'Textfarbe', 'Font size': 'Schriftgröße', 'More formatting': 'Weitere Formatierung',
    'Toggle plain text / rich text': 'Nur-Text / formatierter Text',
    'Discard this message?': 'Diese Nachricht verwerfen?', 'Send this message without a subject?': 'Diese Nachricht ohne Betreff senden?',
    'Saved': 'Gespeichert', 'Saving…': 'Wird gespeichert…', 'Not saved': 'Nicht gespeichert', 'Saved to Drafts': 'In Entwürfen gespeichert',
    'Draft discarded': 'Entwurf verworfen', 'Could not open the draft': 'Der Entwurf konnte nicht geöffnet werden',
    'Add an account before composing': 'Füge zuerst ein Konto hinzu', 'Add an account to send from': 'Füge ein Konto zum Senden hinzu',
    'The scheduled time is in the past — pick a later time': 'Der geplante Zeitpunkt liegt in der Vergangenheit — wähle einen späteren',
    'Scheduled send cancelled': 'Geplantes Senden abgebrochen', 'Cancel scheduled send': 'Geplantes Senden abbrechen',
    'Send cancelled — draft restored': 'Senden abgebrochen — Entwurf wiederhergestellt', 'Undo': 'Rückgängig',
    'Sending': 'Wird gesendet', 'Unknown error': 'Unbekannter Fehler', 'Add a signature…': 'Signatur hinzufügen…',
    'Enter a recipient': 'Gib einen Empfänger ein',

    // AI
    'AI': 'KI', 'AI assistant': 'KI-Assistent', 'AI is off': 'KI ist aus', 'Write with AI': 'Mit KI schreiben',
    'Draft a reply': 'Antwort entwerfen', 'Improve writing': 'Text verbessern', 'Fix spelling & grammar': 'Rechtschreibung & Grammatik korrigieren',
    'Make shorter': 'Kürzer fassen', 'More formal': 'Förmlicher', 'Friendlier': 'Freundlicher', 'Write': 'Schreiben',
    'Write something first, or select the text AI should change.': 'Schreib zuerst etwas oder markiere den Text, den die KI ändern soll.',
    'Assistant': 'Assistent', 'Model': 'Modell', 'API key': 'API-Schlüssel', 'Connect': 'Verbinden', 'Connecting…': 'Verbinde…',
    'Connected': 'Verbunden', 'Check connection': 'Verbindung prüfen',
    'Connect to load the models this provider offers': 'Verbinde dich, um die Modelle dieses Anbieters zu laden',
    'Connected, but the server lists no models. Install or load a model first.': 'Verbunden, aber der Server bietet keine Modelle an. Installiere oder lade zuerst ein Modell.',
    'Everything stays on this computer: mail is only sent to the local AI app.': 'Alles bleibt auf diesem Computer: Mails gehen nur an die lokale KI-App.',
    'Where the local AI app listens': 'Adresse der lokalen KI-App',
    'Summarize long mail, draft replies and polish your writing with an AI model you choose — one running on this computer (Ollama, LM Studio) or a cloud service. While AI is off, Mailplane shows no AI features.':
      'Lange Mails zusammenfassen, Antworten entwerfen und Texte verbessern — mit einem KI-Modell deiner Wahl, lokal auf diesem Computer (Ollama, LM Studio) oder als Cloud-Dienst. Solange die KI aus ist, zeigt Mailplane keine KI-Funktionen.',

    // Settings
    'Settings': 'Einstellungen', 'General': 'Allgemein', 'Appearance': 'Darstellung',
    'Notifications': 'Mitteilungen', 'Reading': 'Lesen', 'Reading pane': 'Lesebereich', 'Composing': 'Verfassen', 'Shortcuts': 'Kurzbefehle',
    'Keyboard shortcuts': 'Tastenkürzel', 'About': 'Über', 'Theme': 'Design', 'Light': 'Hell', 'Dark': 'Dunkel', 'System': 'System',
    'Automatic': 'Automatisch', 'Accent colour': 'Akzentfarbe', 'Custom colour': 'Eigene Farbe', 'Custom': 'Eigene', 'Background': 'Hintergrund',
    'Frosted': 'Milchglas', 'Solid': 'Deckend', 'Layout': 'Layout', 'Language': 'Sprache', 'Toggle dark mode': 'Dunkelmodus umschalten',
    'Lime': 'Limette', 'Mint': 'Minze', 'Sky': 'Himmel', 'Lilac': 'Flieder', 'Peach': 'Pfirsich', 'Sand': 'Sand', 'Graphite': 'Graphit',
    'Notification content': 'Inhalt der Mitteilungen', 'Turn both off to only see “New email received”.': 'Schalte beides aus, um nur „Neue Mail erhalten“ zu sehen.',
    'On launch': 'Beim Start', 'Signature': 'Signatur', 'Account colour': 'Kontofarbe', 'Colour': 'Farbe', 'Color': 'Farbe', 'Icon': 'Symbol',
    'Display name': 'Anzeigename', 'Display Name': 'Anzeigename', 'Save Changes': 'Änderungen speichern', 'Account saved': 'Konto gespeichert',
    'Remove Account': 'Konto entfernen', 'Remove': 'Entfernen', 'No accounts added yet.': 'Noch keine Konten hinzugefügt.',
    'Add Account': 'Konto hinzufügen', 'Make default': 'Als Standard festlegen', 'Software update': 'Softwareaktualisierung',
    'Install updates automatically': 'Updates automatisch installieren', 'Check now': 'Jetzt prüfen', 'Checking for updates…': 'Suche nach Updates…',
    'Mailplane is up to date.': 'Mailplane ist auf dem neuesten Stand.', 'Restart to update': 'Zum Aktualisieren neu starten',
    'Download new versions in the background and install them when you quit': 'Neue Versionen im Hintergrund laden und beim Beenden installieren',
    'Mailplane checks GitHub for new versions and offers the download': 'Mailplane sucht auf GitHub nach neuen Versionen und bietet den Download an',
    'New versions come from GitHub Releases': 'Neue Versionen kommen aus GitHub Releases',
    'Updates are checked in installed builds only.': 'Updates werden nur in installierten Versionen geprüft.',
    'What’s new': 'Neuigkeiten', 'Source code': 'Quellcode', 'Report issue': 'Problem melden', 'Built with': 'Erstellt mit',
    'Calm, fast email for every account you have.': 'Ruhige, schnelle Mail für all deine Konten.',
    'Quiet by design — no tracking pixels, remote images only when you ask': 'Leise von Grund auf — keine Tracking-Pixel, externe Bilder nur auf Wunsch',
    'Passwords are stored in your system keychain, never on a server': 'Passwörter liegen im Schlüsselbund deines Systems, nie auf einem Server',
    'Stored encrypted in your system keychain': 'Verschlüsselt im Schlüsselbund deines Systems gespeichert',
    'Saved in your system keychain. Enter a new one to replace it.': 'Im Schlüsselbund gespeichert. Gib ein neues ein, um es zu ersetzen.',
    'Server settings': 'Servereinstellungen', 'Edit server settings': 'Servereinstellungen bearbeiten',
    'Calendar Accounts': 'Kalenderkonten', 'Add Calendar': 'Kalender hinzufügen', 'Add Calendar Account': 'Kalenderkonto hinzufügen',
    'Connect a CalDAV calendar account': 'Ein CalDAV-Kalenderkonto verbinden', 'No calendar accounts connected.': 'Keine Kalenderkonten verbunden.',
    'Remove calendar account': 'Kalenderkonto entfernen', 'Calendar account removed': 'Kalenderkonto entfernt',
    'Calendar account added — no calendars found on this server': 'Kalenderkonto hinzugefügt — auf diesem Server wurden keine Kalender gefunden',
    'Could not connect to CalDAV server. Check the URL and credentials.': 'Keine Verbindung zum CalDAV-Server. Prüfe URL und Zugangsdaten.',
    'Could not save calendar account.': 'Kalenderkonto konnte nicht gespeichert werden.',
    'Select a provider or enter a server URL.': 'Wähle einen Anbieter oder gib eine Server-URL ein.', 'Server URL': 'Server-URL',
    'Previous month': 'Vorheriger Monat', 'Next month': 'Nächster Monat',
    'Add App': 'App hinzufügen', 'App name': 'App-Name', 'App removed': 'App entfernt', 'Remove app': 'App entfernen',
    'No apps added yet.': 'Noch keine Apps hinzugefügt.', 'Embed any web app in your sidebar': 'Bette beliebige Web-Apps in deine Seitenleiste ein',
    'Enter an app name': 'Gib einen App-Namen ein', 'Reload': 'Neu laden', 'Back': 'Zurück',
    'Smart inbox': 'Intelligenter Posteingang', 'Preview lines': 'Vorschauzeilen', 'None': 'Keine', 'Group by conversation': 'Nach Konversation gruppieren',
    'Confirm before discarding': 'Vor dem Verwerfen nachfragen', 'Sender pictures': 'Absenderbilder', 'Density': 'Dichte',
    'Comfortable': 'Komfortabel', 'Compact': 'Kompakt', 'Undo send': 'Senden rückgängig', 'Off': 'Aus', 'Show / hide sidebar': 'Seitenleiste ein/aus',
    'Show / hide message list': 'Nachrichtenliste ein/aus', 'Move around': 'Navigieren', 'Act on a message': 'Nachricht bearbeiten',
    'Next message': 'Nächste Nachricht', 'Previous message': 'Vorherige Nachricht', 'Close / dismiss': 'Schließen',
    'Rich text by default': 'Standardmäßig formatierter Text', 'Spell check': 'Rechtschreibprüfung',
    'Quote the original in replies': 'Original in Antworten zitieren', 'Reply from the receiving account': 'Vom empfangenden Konto antworten',
    'Show new-mail notifications': 'Mitteilungen für neue Mails', 'Play a sound': 'Ton abspielen', 'Show the sender': 'Absender anzeigen',
    'Show the subject': 'Betreff anzeigen', 'Unread count on the app icon': 'Anzahl ungelesener Mails am App-Symbol',
    'Block remote images': 'Externe Bilder blockieren', 'Check for new mail': 'Nach neuen Mails suchen',
    'Open at login': 'Beim Anmelden öffnen', 'Keep running when closed': 'Nach dem Schließen weiterlaufen',
    'Default mail app': 'Standard-Mail-App', 'Mailplane is your default mail app': 'Mailplane ist deine Standard-Mail-App',

    // Account setup
    'Welcome to Mailplane': 'Willkommen bei Mailplane', 'Continue': 'Weiter', 'Cancel': 'Abbrechen', 'Done': 'Fertig', 'Create': 'Erstellen',
    'Rename': 'Umbenennen', 'Dismiss': 'Schließen', 'Clear': 'Leeren', 'Go': 'Los', 'Other': 'Andere', 'or': 'oder',
    'What\'s your email address?': 'Wie lautet deine E-Mail-Adresse?', 'Email address': 'E-Mail-Adresse',
    'We\'ll find the right server settings for you.': 'Wir finden die passenden Servereinstellungen für dich.',
    'We’ll look up the server settings when you continue': 'Wir suchen die Servereinstellungen, sobald du fortfährst',
    'Works with Gmail, Outlook, iCloud, Yahoo, Fastmail and any IMAP server': 'Funktioniert mit Gmail, Outlook, iCloud, Yahoo, Fastmail und jedem IMAP-Server',
    'Enter a valid email address': 'Gib eine gültige E-Mail-Adresse ein', 'Password': 'Passwort', 'Enter your password': 'Gib dein Passwort ein',
    'Show password': 'Passwort anzeigen', 'Hide password': 'Passwort verbergen', 'App password': 'App-Passwort',
    'App-specific password': 'App-spezifisches Passwort', 'App password recommended': 'App-Passwort empfohlen', 'API token': 'API-Token',
    'Paste it below': 'Füge es unten ein', 'Paste the password below': 'Füge das Passwort unten ein', 'Paste the token below': 'Füge das Token unten ein',
    'Gmail needs an app password': 'Gmail braucht ein App-Passwort', 'Yahoo needs an app password': 'Yahoo braucht ein App-Passwort',
    'AOL needs an app password': 'AOL braucht ein App-Passwort', 'Fastmail connects with an API token': 'Fastmail verbindet sich mit einem API-Token',
    'Signing in to Outlook': 'Anmeldung bei Outlook', 'Sign in to your Apple Account': 'Melde dich bei deinem Apple Account an',
    'Allow IMAP access first': 'Erlaube zuerst den IMAP-Zugriff', 'Then sign in here with your normal password': 'Melde dich dann hier mit deinem normalen Passwort an',
    'With two-step verification on, create an app password and use that': 'Mit aktivierter Zwei-Faktor-Anmeldung erstellst du ein App-Passwort und verwendest dieses',
    'Use your normal password if you don’t use two-step verification': 'Nutze dein normales Passwort, wenn du keine Zwei-Faktor-Anmeldung verwendest',
    'Some work and school accounts only allow browser sign-in (OAuth), which Mailplane doesn’t support yet':
      'Manche Arbeits- und Schulkonten erlauben nur die Anmeldung im Browser (OAuth), die Mailplane noch nicht unterstützt',
    'Open Google app passwords': 'Google App-Passwörter öffnen', 'Open Yahoo account security': 'Yahoo Kontosicherheit öffnen',
    'Open AOL account security': 'AOL Kontosicherheit öffnen', 'Open Microsoft security settings': 'Microsoft Sicherheitseinstellungen öffnen',
    'Open Apple Account': 'Apple Account öffnen', 'Open Fastmail API tokens': 'Fastmail API-Tokens öffnen', 'Open Account Security': 'Kontosicherheit öffnen',
    'Incoming mail': 'Eingehende Mails', 'Outgoing mail': 'Ausgehende Mails', 'Incoming mail (IMAP)': 'Eingehende Mails (IMAP)',
    'Outgoing mail (SMTP)': 'Ausgehende Mails (SMTP)', 'IMAP server': 'IMAP-Server', 'SMTP server': 'SMTP-Server', 'IMAP port': 'IMAP-Port',
    'SMTP port': 'SMTP-Port', 'Server address': 'Serveradresse', 'Username': 'Benutzername', 'Email / Username': 'E-Mail / Benutzername',
    'usually your full email address': 'meist deine vollständige E-Mail-Adresse', 'Only if your server needs one': 'Nur falls dein Server einen braucht',
    'Security': 'Sicherheit', 'Secure': 'Sicher', 'Custom server': 'Eigener Server', 'Fill in both server addresses': 'Fülle beide Serveradressen aus',
    'Your provider\'s help pages list these. Most use SSL on port 993 (IMAP) and STARTTLS on 587 (SMTP).':
      'Die Hilfeseiten deines Anbieters nennen diese Werte. Meist SSL auf Port 993 (IMAP) und STARTTLS auf 587 (SMTP).',
    'Without encryption your password travels in plain text. Only use this for servers on your own machine or network.':
      'Ohne Verschlüsselung wird dein Passwort im Klartext übertragen. Nutze das nur für Server auf deinem eigenen Rechner oder in deinem Netzwerk.',
    'Looking up server settings…': 'Servereinstellungen werden gesucht…', 'Settings found automatically': 'Einstellungen automatisch gefunden',
    'Settings are built in': 'Einstellungen sind hinterlegt', 'Checking for mail': 'Mails werden geprüft', 'Sign in': 'Anmelden',
    'You\'re connected': 'Du bist verbunden', 'Couldn’t connect': 'Verbindung fehlgeschlagen', 'What went wrong': 'Was schiefging',
    'Try another password': 'Anderes Passwort versuchen', 'The server rejected your email or password. Check them and try again.':
      'Der Server hat deine E-Mail-Adresse oder dein Passwort abgelehnt. Prüfe beides und versuch es noch einmal.',
    'Make this account easy to recognise.': 'Mach dieses Konto leicht erkennbar.', 'Your name': 'Dein Name',
    'shown to people you write to': 'wird deinen Empfängern angezeigt', 'Personal': 'Privat', 'Work': 'Arbeit', 'Study': 'Studium',
    'This account has already been added': 'Dieses Konto wurde bereits hinzugefügt', 'Failed to save account': 'Konto konnte nicht gespeichert werden',
    'Email and password are required.': 'E-Mail und Passwort sind erforderlich.', 'Open inbox': 'Posteingang öffnen',

    // Folders dialogs
    'New Folder': 'Neuer Ordner', 'Rename Folder': 'Ordner umbenennen', 'Folder name': 'Ordnername', 'Folder created': 'Ordner erstellt',
    'Folder renamed': 'Ordner umbenannt', 'Folder deleted': 'Ordner gelöscht',
    'This folder and all emails inside it will be permanently deleted. This cannot be undone.':
      'Dieser Ordner und alle Mails darin werden endgültig gelöscht. Das lässt sich nicht rückgängig machen.',

    // Calendar / dates
    'January': 'Januar', 'February': 'Februar', 'March': 'März', 'April': 'April', 'May': 'Mai', 'June': 'Juni', 'July': 'Juli',
    'August': 'August', 'September': 'September', 'October': 'Oktober', 'November': 'November', 'December': 'Dezember',
    'Mon': 'Mo', 'Tue': 'Di', 'Wed': 'Mi', 'Thu': 'Do', 'Fri': 'Fr', 'Sat': 'Sa', 'Sun': 'So',

    // Updates banner
    'Restart Now': 'Jetzt neu starten', 'Later': 'Später', 'Update available': 'Update verfügbar',

    // Settings rows
    "After 3 seconds": "Nach 3 Sekunden",
    "Ask before the Discard button throws away a message with text (closing keeps it in Drafts)": "Nachfragen, bevor „Verwerfen“ eine Nachricht mit Text löscht (Schließen behält sie in den Entwürfen)",
    "Badge the Dock icon with unread inbox mail": "Ungelesene Mails im Posteingang am Dock-Symbol anzeigen",
    "Body preview under the subject (shown once a message has been opened)": "Textvorschau unter dem Betreff (sobald eine Nachricht geöffnet wurde)",
    "Bundle replies with the same subject": "Antworten mit gleichem Betreff bündeln",
    "Check spelling": "Rechtschreibung prüfen",
    "Closing the window keeps Mailplane in the system tray and still notifies you": "Beim Schließen bleibt Mailplane im Infobereich und benachrichtigt dich weiter",
    "Compact shows more messages: one line per message, no avatars": "Kompakt zeigt mehr Nachrichten: eine Zeile pro Nachricht, keine Avatare",
    "Create one called “Mailplane” and paste it below": "Erstelle eines namens „Mailplane“ und füge es unten ein",
    "Default email app": "Standard-E-Mail-App",
    "Delay before a message actually leaves": "Wartezeit, bevor eine Nachricht wirklich verschickt wird",
    "Email links (mailto:) open in Mailplane": "E-Mail-Links (mailto:) öffnen sich in Mailplane",
    "Email links open in another app": "E-Mail-Links öffnen sich in einer anderen App",
    "Every 10 minutes": "Alle 10 Minuten",
    "Every 2 minutes": "Alle 2 Minuten",
    "Every 5 minutes": "Alle 5 Minuten",
    "Every minute": "Jede Minute",
    "Folder shown when Mailplane starts": "Ordner, der beim Start angezeigt wird",
    "Go to Sign-In and Security → App-Specific Passwords": "Öffne Anmeldung und Sicherheit → App-spezifische Passwörter",
    "Last viewed folder": "Zuletzt angesehener Ordner",
    "Load photos and company logos from Gravatar and the sender’s website": "Fotos und Firmenlogos von Gravatar und der Website des Absenders laden",
    "Manually": "Manuell",
    "Never": "Nie",
    "New mail": "Neue Mails",
    "New mail also arrives instantly via push when the server supports it": "Neue Mails kommen zusätzlich sofort per Push, wenn der Server das unterstützt",
    "Next (↓)": "Weiter (↓)",
    "Previous (↑)": "Zurück (↑)",
    "Off starts new messages in plain text": "Aus: neue Nachrichten beginnen als Nur-Text",
    "Open Settings → Privacy & Security → API tokens": "Öffne Einstellungen → Privatsphäre & Sicherheit → API-Tokens",
    "Open to": "Öffnen mit",
    "Otherwise the currently selected account is used": "Sonst wird das gerade ausgewählte Konto verwendet",
    "Paste key": "Schlüssel einfügen",
    "Paste the 16-character password below": "Füge das 16-stellige Passwort unten ein",
    "People / Updates / Newsletters tabs and bundles for busy senders": "Tabs für Personen / Updates / Newsletter und Bündel für Vielschreiber",
    "Play sound": "Ton abspielen",
    "Provider": "Anbieter",
    "Quote original message": "Ursprüngliche Nachricht zitieren",
    "Refresh interval": "Abrufintervall",
    "Rich text": "Formatierter Text",
    "Sender name": "Absendername",
    "Show notifications": "Mitteilungen anzeigen",
    "Show unread inbox mail on the taskbar icon": "Ungelesene Mails am Taskleistensymbol anzeigen",
    "Start quietly in the background so new mail notifications arrive": "Leise im Hintergrund starten, damit Mitteilungen ankommen",
    "Stops senders from tracking when you open a message": "Verhindert, dass Absender sehen, wann du eine Nachricht öffnest",
    "System notification when new mail arrives": "Systemmitteilung bei neuen Mails",
    "Tell AI what to write or change…": "Sag der KI, was sie schreiben oder ändern soll…",
    "Turn on 2-Step Verification for your Google account": "Aktiviere die Bestätigung in zwei Schritten für dein Google-Konto",
    "Unread count on app icon": "Anzahl ungelesener Mails am App-Symbol",
    "What should the reply say?": "Was soll in der Antwort stehen?",
    "When opened": "Beim Öffnen",
    "Window": "Fenster",
    "Shift": "Umschalt",
    "Editor": "Editor",
    "Creative": "Kreativ",
    "Fast": "Schnell",
    "Date:": "Datum:",
    "From:": "Von:",
    "Subject:": "Betreff:",
    "To:": "An:",
    "your text": "dein Text",
    "↑↓ Navigate": "↑↓ Navigieren",
    "⌘N Compose": "⌘N Verfassen",
    "⌘R Reply": "⌘R Antworten",
    "⌫ Delete": "⌫ Löschen",
    "Esc": "Esc",
    "Del": "Entf",
    "Backspace": "Rücktaste",
    "Enter": "Eingabe",
    "Escape": "Esc",
    'System follows your computer’s language': 'System folgt der Sprache deines Computers',
    'to': 'an', 'Attachment': 'Anhang',
    'Quick pick': 'Schnellauswahl', 'Resize message list': 'Nachrichtenliste anpassen', 'Resize sidebar': 'Seitenleiste anpassen',
    'Drag to resize · double-click to reset · Enter to hide the message list': 'Ziehen zum Anpassen · Doppelklick zum Zurücksetzen · Eingabe blendet die Nachrichtenliste aus',
    'Drag to resize · double-click to reset · Enter to hide the sidebar': 'Ziehen zum Anpassen · Doppelklick zum Zurücksetzen · Eingabe blendet die Seitenleiste aus',
    'e.g. Google Calendar': 'z. B. Google Kalender', 'Global': 'Global', 'Multi': 'Mehrere', 'Dev': 'Entwicklung',
    // Main process (menus, notifications)
    'About Mailplane': 'Über Mailplane', 'Preferences…': 'Einstellungen…', 'Check for New Mail': 'Nach neuen Mails suchen',
    'Search Mail': 'Mails durchsuchen', 'Open Mailplane': 'Mailplane öffnen', 'Quit Mailplane': 'Mailplane beenden', 'View': 'Darstellung',
    'Delete Message  ⌫': 'Nachricht löschen  ⌫', 'Mark as Read / Unread  U': 'Gelesen / ungelesen  U', 'Star / Unstar  S': 'Markieren  S',
    'Star / Unstar': 'Markieren / Markierung entfernen', 'Show / Hide Sidebar': 'Seitenleiste ein/aus', 'Show / Hide Message List': 'Nachrichtenliste ein/aus',
    'Snooze…': 'Zurückstellen…', 'New Folder…': 'Neuer Ordner…', 'Rename…': 'Umbenennen…', 'Delete Folder': 'Ordner löschen',
    'Edit Account…': 'Konto bearbeiten…', 'New email received': 'Neue Mail erhalten', 'Back from snooze': 'Zurück aus der Pause',
    'A snoozed message is back': 'Eine zurückgestellte Nachricht ist wieder da', 'Mark as read': 'Als gelesen markieren', 'Reply…': 'Antworten…',
  };

  const DE_PATTERNS = [
    ['{n} unread', '{n} ungelesen'],
    ['New Message ({k})', 'Neue Nachricht ({k})'],
    ['Settings ({k})', 'Einstellungen ({k})'],
    ['Hide sidebar ({k})', 'Seitenleiste ausblenden ({k})'],
    ['Show sidebar ({k})', 'Seitenleiste einblenden ({k})'],
    ['{n} selected', '{n} ausgewählt'],
    ['{n} scheduled', '{n} geplant'],
    ['{n} result', '{n} Ergebnis'],
    ['{n} results', '{n} Ergebnisse'],
    ['{n} new', '{n} neu'],
    ['{n} new messages', '{n} neue Nachrichten'],
    ['{n} messages', '{n} Nachrichten'],
    ['Load {n} more', '{n} weitere laden'],
    ['+{n} more', '+{n} weitere'],
    ['Search {folder}', '{folder} durchsuchen'],
    ['Search {folder} · {name}', '{folder} durchsuchen · {name}'],
    ['Search mail for “{q}”', 'Mails nach „{q}“ durchsuchen'],
    ['Nothing left in {folder}. New mail shows up here.', 'Nichts mehr in {folder}. Neue Mails erscheinen hier.'],
    ['No messages in {folder}.', 'Keine Nachrichten in {folder}.'],
    ['Nothing matches “{q}” in {folder}.', 'Nichts passt zu „{q}“ in {folder}.'],
    ['No unread messages.', 'Keine ungelesenen Nachrichten.'],
    ['No unread messages in {folder}.', 'Keine ungelesenen Nachrichten in {folder}.'],
    ['Snoozed until {when}', 'Zurückgestellt bis {when}'],
    ['“{subject}” is back from snooze', '„{subject}“ ist wieder da'],
    ['Archived {n} messages', '{n} Nachrichten archiviert'],
    ['Marked {n} as read', '{n} als gelesen markiert'],
    ['Moved to {folder}', 'Verschoben nach {folder}'],
    ['Sent: {subject}', 'Gesendet: {subject}'],
    ['Scheduled for {when}', 'Geplant für {when}'],
    ['Send {when}', 'Senden {when}'],
    ['{used} of {total} used', '{used} von {total} belegt'],
    ['Scheduled send failed: {error}', 'Geplantes Senden fehlgeschlagen: {error}'],
    ['Send failed: {error}', 'Senden fehlgeschlagen: {error}'],
    ['Load failed: {error}', 'Laden fehlgeschlagen: {error}'],
    ['Could not save the draft: {error}', 'Entwurf konnte nicht gespeichert werden: {error}'],
    ['Archive failed: {error}', 'Archivieren fehlgeschlagen: {error}'],
    ['Delete failed: {error}', 'Löschen fehlgeschlagen: {error}'],
    ['Snooze failed: {error}', 'Zurückstellen fehlgeschlagen: {error}'],
    ['Version {v}', 'Version {v}'],
    ['Open-source email · Version {v}', 'Open-Source-Mail · Version {v}'],
    ['Verified sender · {checks}', 'Verifizierter Absender · {checks}'],
    ['{label}: {result} — the sender could not be verified', '{label}: {result} — der Absender konnte nicht verifiziert werden'],
    ['{name} — settings are built in', '{name} — Einstellungen sind hinterlegt'],
    ['✓ {name} — settings are built in', '✓ {name} — Einstellungen sind hinterlegt'],
    ['This draft had {n} attachments — attach them again before sending.', 'Dieser Entwurf hatte {n} Anhänge — hänge sie vor dem Senden erneut an.'],
    ['This draft had {n} attachment — attach it again before sending.', 'Dieser Entwurf hatte {n} Anhang — hänge ihn vor dem Senden erneut an.'],
  ];

  const LOCALES = {
    en: { name: 'English', strings: {}, patterns: [], folders: {} },
    de: { name: 'Deutsch', strings: DE, patterns: DE_PATTERNS, folders: DE_FOLDERS },
  };

  /** 'system' → the OS language when we have it, else English. */
  function resolveLocale(pref, systemLang) {
    if (pref && pref !== 'system') return LOCALES[pref] ? pref : 'en';
    const l = String(systemLang || '').slice(0, 2).toLowerCase();
    return LOCALES[l] ? l : 'en';
  }

  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function compile(loc) {
    // Most specific first: "Search {folder} · {name}" before "Search {folder}"
    const literal = src => src.replace(/\{\w+\}/g, '').length;
    const sorted = [...loc.patterns].sort((a, b) => literal(b[0]) - literal(a[0]));
    return sorted.map(([src, dst]) => {
      const names = [];
      const re = new RegExp('^' + src.split(/(\{\w+\})/).map(part => {
        const m = part.match(/^\{(\w+)\}$/);
        if (!m) return escRe(part);
        names.push(m[1]);
        return '(.+?)';
      }).join('') + '$', 's');
      return { re, names, dst };
    });
  }

  /** Returns t(text, {folder?: true}) for a locale. Unknown text comes back unchanged. */
  function translator(code) {
    const loc = LOCALES[code] || LOCALES.en;
    const pats = compile(loc);
    const folder = s => loc.folders[s] || s;
    function t(text, opts = {}) {
      if (text == null || code === 'en') return text;
      const src = String(text);
      const key = src.trim();
      if (!key) return src;
      let out;
      if (opts.folder && loc.folders[key]) out = loc.folders[key];
      else if (Object.prototype.hasOwnProperty.call(loc.strings, key)) out = loc.strings[key];
      else {
        for (const p of pats) {
          const m = key.match(p.re);
          if (!m) continue;
          out = p.names.reduce((acc, n, i) => acc.replace(`{${n}}`, n === 'folder' ? folder(m[i + 1]) : m[i + 1]), p.dst);
          break;
        }
      }
      if (out === undefined) return src;
      return src.replace(key, out);   // keep surrounding whitespace
    }
    t.locale = code;
    return t;
  }

  // Text inside these holds mail content or names — never translate it
  const RAW = [
    '.email-sender', '.email-subject', '.email-snippet', '.email-item-top', '.detail-subject', '.detail-sender-meta',
    '.detail-body', '.thread-member', '.thread-context', '.bundle-text', '.acc-tab-label', '.acc-tip', '.sob-subj',
    '.pal-sub', '.recipient-chip', '.compose-attach-list', '.summary-text', '.att-name', '.cal-event', '[data-raw]',
    '[contenteditable="true"]', 'iframe', 'textarea', 'script', 'style', 'code', 'pre',
  ].join(',');
  // Folder names read as nouns here ("Archiv"), not verbs ("Archivieren")
  const FOLDERISH = '.folder-btn, #listTitle, .pal-group-folders .pal-label, .folder-name, .move-target';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'data-placeholder'];

  /** Translates the document now and everything added to it later (renderer only). */
  function installDomTranslator(doc, t) {
    if (!doc || t.locale === 'en') return () => {};
    const textNode = (n) => {
      const el = n.parentElement;
      if (!el || el.closest(RAW)) return;
      const v = n.nodeValue;
      if (!v || !/[A-Za-z]/.test(v)) return;
      const out = t(v, { folder: !!el.closest(FOLDERISH) });
      if (out !== v) n.nodeValue = out;
    };
    const attrs = (el) => {
      for (const a of ATTRS) {
        const v = el.getAttribute?.(a);
        if (v && /[A-Za-z]/.test(v)) {
          const out = t(v, { folder: !!el.closest?.(FOLDERISH) && a !== 'placeholder' });
          if (out !== v) el.setAttribute(a, out);
        }
      }
    };
    const walk = (root) => {
      if (root.nodeType === 3) { textNode(root); return; }
      if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
      if (root.nodeType === 1) attrs(root);
      const w = doc.createTreeWalker(root, 1 | 4);
      let n;
      while ((n = w.nextNode())) { if (n.nodeType === 3) textNode(n); else attrs(n); }
    };
    walk(doc.body || doc.documentElement);
    if (doc.title) doc.title = t(doc.title);
    const obs = new (doc.defaultView.MutationObserver)(muts => {
      for (const m of muts) {
        if (m.type === 'characterData') textNode(m.target);
        else if (m.type === 'attributes') attrs(m.target);
        else m.addedNodes.forEach(walk);
      }
    });
    obs.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    return () => obs.disconnect();
  }

  const available = () => Object.entries(LOCALES).map(([code, l]) => ({ code, name: l.name }));

  return { LOCALES, resolveLocale, translator, installDomTranslator, available };
}));
