package app.mailplane.android.ui

import app.mailplane.core.FolderRole
import app.mailplane.core.MailFolder
import java.util.Locale

/**
 * Interface language, the same way the desktop does it (src/i18n.js): English
 * text is the key, so untranslated strings simply stay English. Settings →
 * Language picks System / English / Deutsch; MainActivity re-composes the
 * whole UI when it changes. Mail content never goes through [tr].
 */
object I18n {
    @Volatile var code: String = "en"
        private set

    val languages = listOf("system" to "System", "en" to "English", "de" to "Deutsch")

    /** "system" → the phone's language when we have it, else English. */
    fun resolve(pref: String?): String {
        val p = pref ?: "system"
        if (p != "system") return if (p == "de") "de" else "en"
        return if (Locale.getDefault().language == "de") "de" else "en"
    }

    fun apply(pref: String?) { code = resolve(pref) }

    private class Pattern(val re: Regex, val names: List<String>, val out: String)

    private val dePatterns: List<Pattern> by lazy {
        DE_PATTERNS.sortedByDescending { it.first.replace(Regex("\\{\\w+\\}"), "").length }.map { (src, dst) ->
            val names = mutableListOf<String>()
            val re = src.split(Regex("(?=\\{\\w+\\})|(?<=\\})")).joinToString("") { part ->
                val m = Regex("^\\{(\\w+)\\}$").find(part)
                if (m != null) { names += m.groupValues[1]; "(.+?)" } else Regex.escape(part)
            }
            Pattern(Regex("^$re$", RegexOption.DOT_MATCHES_ALL), names, dst)
        }
    }

    fun tr(text: String): String {
        if (code == "en" || text.isBlank()) return text
        DE[text]?.let { return it }
        for (p in dePatterns) {
            val m = p.re.find(text) ?: continue
            var out = p.out
            p.names.forEachIndexed { i, n ->
                val v = m.groupValues[i + 1]
                out = out.replace("{$n}", if (n == "folder") DE_FOLDERS[v] ?: v else v)
            }
            return out
        }
        return text
    }

    /** Role folders get their translated name; the user's own folders keep theirs. */
    fun folderName(f: MailFolder): String = when (f.role) {
        FolderRole.INBOX -> tr("Inbox")
        FolderRole.SENT -> tr("Sent")
        FolderRole.DRAFTS -> tr("Drafts")
        FolderRole.TRASH -> tr("Trash")
        FolderRole.SPAM -> tr("Spam")
        FolderRole.ARCHIVE -> if (code == "en") f.name else DE_FOLDERS["Archive"]!!
        null -> if (f.name.equals("Snoozed", ignoreCase = true)) tr("Snoozed") else f.name
    }

    private val DE_FOLDERS = mapOf(
        "Inbox" to "Posteingang", "Sent" to "Gesendet", "Drafts" to "Entwürfe", "Trash" to "Papierkorb",
        "Spam" to "Spam", "Archive" to "Archiv", "Starred" to "Markiert", "All inboxes" to "Alle Posteingänge",
        "Snoozed" to "Zurückgestellt",
    )

    private val DE = mapOf(
        // Inbox & folders
        "Inbox" to "Posteingang", "Sent" to "Gesendet", "Drafts" to "Entwürfe", "Trash" to "Papierkorb", "Spam" to "Spam",
        "Starred" to "Markiert", "Snoozed" to "Zurückgestellt", "All inboxes" to "Alle Posteingänge", "All" to "Alle",
        "Folders" to "Ordner", "Accounts" to "Konten", "New message" to "Neue Nachricht", "Search" to "Suchen",
        "Close search" to "Suche schließen", "All folders" to "Alle Ordner", "Yesterday" to "Gestern", "Today" to "Heute",
        "Couldn’t load mail" to "Mails konnten nicht geladen werden", "Try again" to "Erneut versuchen", "No results" to "Keine Ergebnisse",
        "Nothing starred" to "Nichts markiert", "Star a message to keep it here, whatever folder it’s in." to "Markiere eine Nachricht, um sie hier zu behalten – egal in welchem Ordner.",
        "All caught up" to "Alles erledigt", "Nothing left in your inbox. New mail shows up here." to "Dein Posteingang ist leer. Neue Mails erscheinen hier.",
        "No messages" to "Keine Nachrichten", "Download and install it straight from GitHub." to "Direkt von GitHub laden und installieren.",
        "Update" to "Aktualisieren", "Later" to "Später", "Attachment" to "Anhang", "Star" to "Markieren", "Unstar" to "Markierung entfernen",
        "Add account" to "Konto hinzufügen", "Settings" to "Einstellungen", "Mailplane" to "Mailplane",
        // Message
        "Back" to "Zurück", "Archive" to "Archivieren", "Delete" to "Löschen", "More" to "Mehr", "Mark as unread" to "Als ungelesen markieren",
        "Reply" to "Antworten", "Reply all" to "Allen antworten", "Forward" to "Weiterleiten", "Open" to "Öffnen", "Show" to "Anzeigen",
        "Pictures from the web are hidden" to "Bilder aus dem Internet sind ausgeblendet", "(empty message)" to "(leere Nachricht)",
        "Snooze" to "Zurückstellen", "Snooze until" to "Zurückstellen bis", "Later today" to "Später heute", "This evening" to "Heute Abend",
        "Tomorrow" to "Morgen", "This weekend" to "Am Wochenende", "Next week" to "Nächste Woche", "Cancel" to "Abbrechen",
        "Summarize" to "Zusammenfassen", "Summary" to "Zusammenfassung", "Summarizing…" to "Wird zusammengefasst…",
        // Compose
        "To" to "An", "Cc" to "Cc", "Bcc" to "Bcc", "Cc Bcc" to "Cc Bcc", "Subject" to "Betreff", "Write your message" to "Schreib deine Nachricht",
        "Send" to "Senden", "Close" to "Schließen", "Discard" to "Verwerfen", "Discard this message?" to "Diese Nachricht verwerfen?",
        "What you wrote won’t be saved." to "Was du geschrieben hast, wird nicht gespeichert.",
        "The saved draft is deleted too." to "Der gespeicherte Entwurf wird ebenfalls gelöscht.", "Keep editing" to "Weiter bearbeiten",
        "Choose sender" to "Absender wählen", "from" to "von", "Attach files" to "Dateien anhängen", "Remove" to "Entfernen",
        "Saved" to "Gespeichert", "Saving…" to "Wird gespeichert…", "Not saved" to "Nicht gespeichert", "Saved to Drafts" to "In Entwürfen gespeichert",
        "Draft discarded" to "Entwurf verworfen", "Draft" to "Entwurf", "Reply all " to "Allen antworten",
        "Write with AI" to "Mit KI schreiben", "Draft a reply" to "Antwort entwerfen", "Improve writing" to "Text verbessern",
        "Make shorter" to "Kürzer fassen", "More formal" to "Förmlicher", "Friendlier" to "Freundlicher",
        "Fix spelling & grammar" to "Rechtschreibung & Grammatik korrigieren", "What should the reply say?" to "Was soll in der Antwort stehen?",
        "Tell AI what to write" to "Sag der KI, was sie schreiben soll", "Write" to "Schreiben", "Working…" to "Arbeitet…",
        "Write something first." to "Schreib zuerst etwas.",
        "Add a recipient" to "Füge einen Empfänger hinzu", "Files over 20 MB can’t be attached" to "Dateien über 20 MB können nicht angehängt werden",
        "Wrong e-mail or password. Gmail, iCloud and Yahoo need an app password." to "Falsche E-Mail-Adresse oder falsches Passwort. Gmail, iCloud und Yahoo brauchen ein App-Passwort.",
        "Server not found — check the server address." to "Server nicht gefunden — prüfe die Serveradresse.",
        "The server didn't respond. Check your connection." to "Der Server hat nicht geantwortet. Prüfe deine Verbindung.",
        "Connection refused — check the port and security settings." to "Verbindung abgelehnt — prüfe Port und Sicherheitseinstellungen.",
        "Secure connection failed — check the security setting." to "Sichere Verbindung fehlgeschlagen — prüfe die Sicherheitseinstellung.",
        "Message no longer exists" to "Die Nachricht existiert nicht mehr", "No archive folder on this server" to "Auf diesem Server gibt es keinen Archivordner",
        "Password missing — sign in again" to "Passwort fehlt — melde dich erneut an", "AI is off" to "KI ist aus",
        "This message can't be snoozed" to "Diese Nachricht kann nicht zurückgestellt werden",
        "Settings are built in" to "Einstellungen sind hinterlegt",
        // View model messages
        "Sent" to "Gesendet", "Archived" to "Archiviert", "Moved to Trash" to "In den Papierkorb verschoben", "Marked as read" to "Als gelesen markiert",
        "Marked as unread" to "Als ungelesen markiert", "Removed from Starred" to "Aus Markiert entfernt", "Something went wrong" to "Etwas ist schiefgelaufen",
        "Back from snooze" to "Zurück aus der Pause",
        // Settings
        "Appearance" to "Darstellung", "Theme" to "Design", "Automatic" to "Automatisch", "Light" to "Hell", "Dark" to "Dunkel",
        "Accent colour" to "Akzentfarbe", "Language" to "Sprache", "System" to "System", "Reading" to "Lesen", "Compact list" to "Kompakte Liste",
        "One line per message, no pictures — fits more on screen" to "Eine Zeile pro Nachricht, keine Bilder – mehr passt auf den Bildschirm",
        "Clear recent searches" to "Letzte Suchen löschen", "Mail" to "Mail", "New mail notifications" to "Mitteilungen für neue Mails",
        "Checked about every 15 minutes" to "Etwa alle 15 Minuten geprüft", "Block remote images" to "Externe Bilder blockieren",
        "Stops senders from tracking when you open a message" to "Verhindert, dass Absender sehen, wann du eine Nachricht öffnest",
        "Updates" to "Updates", "Checking GitHub for a new version…" to "Suche auf GitHub nach einer neuen Version…",
        "New versions come from GitHub Releases. Android asks you to confirm each install." to "Neue Versionen kommen aus GitHub Releases. Android fragt vor jeder Installation nach.",
        "Check again" to "Erneut prüfen", "Check for updates" to "Nach Updates suchen", "Source code" to "Quellcode", "Report a problem" to "Problem melden",
        "Mail stays on the server. You can add the account again later." to "Die Mails bleiben auf dem Server. Du kannst das Konto später wieder hinzufügen.",
        "Lime" to "Limette", "Mint" to "Minze", "Sky" to "Himmel", "Lilac" to "Flieder", "Peach" to "Pfirsich", "Sand" to "Sand", "Graphite" to "Graphit",
        "AI assistant" to "KI-Assistent", "Off" to "Aus", "Provider" to "Anbieter", "Server address" to "Serveradresse", "API key" to "API-Schlüssel",
        "Model" to "Modell", "Load models" to "Modelle laden", "Loading…" to "Wird geladen…", "Save" to "Speichern",
        "Saved in this phone’s secure storage. Enter a new one to replace it." to "Im sicheren Speicher des Telefons abgelegt. Gib einen neuen ein, um ihn zu ersetzen.",
        "Summaries, reply drafts and rewriting with a model you choose. Nothing is sent until you tap an AI button; while AI is off, Mailplane shows no AI features." to
            "Zusammenfassungen, Antwortentwürfe und Umformulieren mit einem Modell deiner Wahl. Es wird nichts gesendet, bevor du auf eine KI-Schaltfläche tippst; solange die KI aus ist, zeigt Mailplane keine KI-Funktionen.",
        "The address of the computer running the AI app" to "Die Adresse des Computers, auf dem die KI-App läuft",
        "Notification actions" to "Aktionen in Mitteilungen", "Mark read" to "Gelesen", "Reply…" to "Antworten…",
        // Onboarding
        "Calm, fast e-mail for every account you have." to "Ruhige, schnelle Mail für all deine Konten.", "Add your first account" to "Füge dein erstes Konto hinzu",
        "Works with Gmail, Outlook, iCloud, Yahoo and any IMAP server" to "Funktioniert mit Gmail, Outlook, iCloud, Yahoo und jedem IMAP-Server",
        "What's your e-mail address?" to "Wie lautet deine E-Mail-Adresse?", "We'll find the right server settings for you." to "Wir finden die passenden Servereinstellungen für dich.",
        "E-mail address" to "E-Mail-Adresse", "Continue" to "Weiter", "Looking up server settings…" to "Servereinstellungen werden gesucht…",
        "Settings are built in" to "Einstellungen sind hinterlegt", "Found in Mozilla's provider directory" to "Im Anbieterverzeichnis von Mozilla gefunden",
        "Found on your domain's autoconfig" to "In der Autoconfig deiner Domain gefunden", "Password" to "Passwort", "App password" to "App-Passwort",
        "Use an app password" to "Nutze ein App-Passwort", "Show password" to "Passwort anzeigen", "Hide password" to "Passwort verbergen",
        "Passwords are encrypted with this phone's secure hardware and never leave it" to "Passwörter werden mit der Sicherheitshardware des Telefons verschlüsselt und verlassen es nie",
        "Sign in" to "Anmelden", "Server settings" to "Servereinstellungen", "Edit server settings" to "Servereinstellungen bearbeiten",
        "Custom server" to "Eigener Server", "Incoming mail" to "Eingehende Mails", "Outgoing mail" to "Ausgehende Mails",
        "Incoming mail (IMAP)" to "Eingehende Mails (IMAP)", "Outgoing mail (SMTP)" to "Ausgehende Mails (SMTP)", "Server" to "Server", "Port" to "Port",
        "Username" to "Benutzername", "Usually your full e-mail address" to "Meist deine vollständige E-Mail-Adresse", "None" to "Keine",
        "Without encryption your password travels in plain text. Only use this for local servers." to "Ohne Verschlüsselung wird dein Passwort im Klartext übertragen. Nutze das nur für lokale Server.",
        "Your provider's help pages list these. Most use SSL on port 993 and STARTTLS on 587." to "Die Hilfeseiten deines Anbieters nennen diese Werte. Meist SSL auf Port 993 und STARTTLS auf 587.",
        "Check connection" to "Verbindung prüfen", "Connecting…" to "Verbinde…", "You're connected" to "Du bist verbunden", "Couldn't connect" to "Verbindung fehlgeschlagen",
        "What went wrong" to "Was schiefging", "Try another password" to "Anderes Passwort versuchen", "Failed" to "Fehlgeschlagen", "Unknown error" to "Unbekannter Fehler",
        "Make this account easy to recognise." to "Mach dieses Konto leicht erkennbar.", "Your name" to "Dein Name", "Shown to people you write to" to "Wird deinen Empfängern angezeigt",
        "Account colour" to "Kontofarbe", "Open inbox" to "Posteingang öffnen", "You can add more accounts any time." to "Du kannst jederzeit weitere Konten hinzufügen.",
        "Quiet notifications when new mail arrives" to "Dezente Mitteilungen bei neuen Mails",
        "That doesn't look like an e-mail address" to "Das sieht nicht nach einer E-Mail-Adresse aus", "This account is already set up" to "Dieses Konto ist bereits eingerichtet",
        "Fill in both servers" to "Fülle beide Server aus", "your provider" to "deinem Anbieter",
    )

    private val DE_PATTERNS = listOf(
        "{n} unread" to "{n} ungelesen",
        "Search {folder}" to "{folder} durchsuchen",
        "Nothing matches “{q}” in {folder}." to "Nichts passt zu „{q}“ in {folder}.",
        "{folder} is empty." to "{folder} ist leer.",
        "Mailplane {v} is available" to "Mailplane {v} ist verfügbar",
        "Mailplane {v} is available." to "Mailplane {v} ist verfügbar.",
        "Downloading {v}… {p}%" to "Lade {v}… {p}%",
        "You have the latest version ({v})." to "Du hast die neueste Version ({v}).",
        "Update to {v}" to "Auf {v} aktualisieren",
        "{n} saved on this phone" to "{n} auf diesem Telefon gespeichert",
        "Remove {x}?" to "{x} entfernen?",
        "Remove {x}" to "{x} entfernen",
        "to {x}" to "an {x}",
        "{n} other message in this conversation" to "{n} weitere Nachricht in dieser Unterhaltung",
        "{n} other messages in this conversation" to "{n} weitere Nachrichten in dieser Unterhaltung",
        "{n} new messages" to "{n} neue Nachrichten",
        "Snoozed until {when}" to "Zurückgestellt bis {when}",
        "Download failed: {e}" to "Download fehlgeschlagen: {e}",
        "Invalid address: {a}" to "Ungültige Adresse: {a}",
        "Create one at {x} ↗" to "Erstelle eines bei {x} ↗",
        "✓ {x} — settings are built in" to "✓ {x} — Einstellungen sind hinterlegt",
        "We'll try {h} — change it under Server settings if needed" to "Wir versuchen {h} — bei Bedarf unter Servereinstellungen ändern",
    )
}

/** Shorthand used across the UI. */
fun tr(text: String): String = I18n.tr(text)
