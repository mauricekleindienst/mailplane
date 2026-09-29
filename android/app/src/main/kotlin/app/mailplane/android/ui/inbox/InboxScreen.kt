@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package app.mailplane.android.ui.inbox

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Drafts
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Report
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.mailplane.android.data.AppRelease
import app.mailplane.android.data.UpdateState
import app.mailplane.android.ui.ListState
import app.mailplane.android.ui.MailViewModel
import app.mailplane.android.ui.STARRED
import app.mailplane.android.ui.ALL_ACCOUNTS
import app.mailplane.android.ui.I18n
import app.mailplane.android.ui.tr
import app.mailplane.android.ui.components.AccountChip
import app.mailplane.android.ui.components.BrandMark
import app.mailplane.android.ui.components.DayHeader
import app.mailplane.android.ui.components.EmptyMessage
import app.mailplane.android.ui.components.InfoCard
import app.mailplane.android.ui.components.SenderAvatar
import app.mailplane.android.ui.components.StorageBar
import app.mailplane.android.ui.theme.Frost
import app.mailplane.core.Account
import app.mailplane.core.Days
import app.mailplane.core.FolderRole
import app.mailplane.core.MailFolder
import app.mailplane.core.MessageSummary
import app.mailplane.core.StorageQuota
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Everything the inbox shows — built from the ViewModel, or from sample data in screenshot tests. */
data class InboxUi(
    val accounts: List<Account>,
    val activeId: String?,
    val unread: Map<String, Int>,
    val list: ListState,
    val compact: Boolean = false,
    val quota: StorageQuota? = null,
    val update: AppRelease? = null,
    val recentSearches: List<String> = emptyList(),
)

class InboxActions(
    val onOpen: (MessageSummary) -> Unit = {},
    val onCompose: () -> Unit = {},
    val onAccount: (String) -> Unit = {},
    val onFolder: (String) -> Unit = {},
    val onRefresh: () -> Unit = {},
    val onLoadMore: () -> Unit = {},
    val onSearch: (String) -> Unit = {},
    val onArchive: (MessageSummary) -> Unit = {},
    val onDelete: (MessageSummary) -> Unit = {},
    val onStar: (MessageSummary) -> Unit = {},
    val onAddAccount: () -> Unit = {},
    val onSettings: () -> Unit = {},
    val onUpdate: (AppRelease) -> Unit = {},
    val onDismissUpdate: (AppRelease) -> Unit = {},
    val onSearchAllFolders: (Boolean) -> Unit = {},
)

@Composable
fun InboxScreen(
    vm: MailViewModel,
    snackbar: SnackbarHostState,
    onOpen: (MessageSummary) -> Unit,
    onCompose: () -> Unit,
    onAddAccount: () -> Unit,
    onSettings: () -> Unit,
) {
    val accounts by vm.accounts.collectAsState()
    val activeId by vm.activeAccountId.collectAsState()
    val st by vm.list.collectAsState()
    val unread by vm.unread.collectAsState()
    val compact by vm.settings.compact.collectAsState()
    val quota by vm.quota.collectAsState()
    val recent by vm.settings.recentSearches.collectAsState()
    val update by vm.updater.state.collectAsState()
    var dismissed by remember { mutableStateOf<String?>(null) }
    val release = (update as? UpdateState.Available)?.release
        ?.takeIf { it.version != dismissed && !vm.updater.dismissed(it) }

    InboxContent(
        ui = InboxUi(accounts, activeId, unread, st, compact, quota, release, recent),
        actions = InboxActions(
            onOpen = onOpen, onCompose = onCompose, onAccount = vm::switchAccount, onFolder = vm::openFolder,
            onRefresh = vm::refresh, onLoadMore = { vm.loadMessages() }, onSearch = vm::search,
            onArchive = vm::archive, onDelete = vm::delete, onStar = vm::toggleFlag,
            onAddAccount = onAddAccount, onSettings = onSettings,
            onUpdate = { vm.installUpdate(it) },
            onSearchAllFolders = vm::setSearchAllFolders,
            onDismissUpdate = { vm.updater.dismiss(it); dismissed = it.version },
        ),
        snackbar = snackbar,
    )
}

@Composable
fun InboxContent(ui: InboxUi, actions: InboxActions, snackbar: SnackbarHostState = remember { SnackbarHostState() },
                 initialSearchOpen: Boolean = false, initialDrawerOpen: Boolean = false) {
    val c = Frost.colors
    val st = ui.list
    val drawer = rememberDrawerState(if (initialDrawerOpen) DrawerValue.Open else DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var searchOpen by remember { mutableStateOf(initialSearchOpen || st.query.isNotEmpty()) }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = c.surface, drawerShape = RoundedCornerShape(topEnd = 24.dp, bottomEnd = 24.dp)) {
                FolderDrawer(
                    folders = if (st.unified) emptyList() else st.folders, current = st.folderPath, quota = ui.quota,
                    accounts = if (st.unified) ui.accounts else emptyList(),
                    onAccount = { actions.onAccount(it); scope.launch { drawer.close() } },
                    onFolder = { actions.onFolder(it); scope.launch { drawer.close() } },
                    onAddAccount = { scope.launch { drawer.close() }; actions.onAddAccount() },
                    onSettings = { scope.launch { drawer.close() }; actions.onSettings() },
                )
            }
        },
    ) {
        Scaffold(
            containerColor = c.canvas,
            snackbarHost = { SnackbarHost(snackbar) },
            floatingActionButton = {
                ExtendedFloatingActionButton(
                    onClick = actions.onCompose, containerColor = c.accent, contentColor = c.onAccent,
                    shape = RoundedCornerShape(16.dp),
                    icon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                    text = { Text(tr("New message")) },
                )
            },
        ) { padding ->
            // Scaffold's padding already includes the status bar
            Column(Modifier.fillMaxSize().padding(top = padding.calculateTopPadding())) {
                Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { scope.launch { drawer.open() } }) { Icon(Icons.Outlined.Menu, tr("Folders"), tint = c.ink) }
                    if (searchOpen) {
                        TextField(
                            value = st.query, onValueChange = actions.onSearch, singleLine = true,
                            placeholder = { Text(if (st.searchAllFolders) tr("Search") else tr("Search ${if (st.isStarred) tr("Inbox") else st.title}")) },
                            leadingIcon = { Icon(Icons.Outlined.Search, null, tint = c.inkTertiary) },
                            modifier = Modifier.weight(1f), shape = RoundedCornerShape(14.dp),
                            colors = TextFieldDefaults.colors(focusedContainerColor = c.tile, unfocusedContainerColor = c.tile,
                                focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = c.ink),
                        )
                        IconButton(onClick = { searchOpen = false; actions.onSearch("") }) { Icon(Icons.Outlined.Close, tr("Close search"), tint = c.ink) }
                    } else {
                        Column(Modifier.weight(1f).padding(start = 4.dp)) {
                            Text(st.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, color = c.ink)
                            val u = when {
                                st.unified -> ui.accounts.sumOf { ui.unread[it.id] ?: 0 }
                                st.isStarred -> 0
                                else -> st.folder?.let { if (it.role == FolderRole.INBOX) ui.unread[ui.activeId] ?: it.unread else it.unread } ?: 0
                            }
                            if (u > 0) Text(tr("$u unread"), style = MaterialTheme.typography.bodySmall, color = c.inkSecondary)
                        }
                        IconButton(onClick = { searchOpen = true }) { Icon(Icons.Outlined.Search, tr("Search"), tint = c.ink) }
                    }
                }
                if (searchOpen) {
                    // Search the open folder, or every folder (Trash and Spam aside)
                    Row(Modifier.padding(start = 16.dp, top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(false to st.title, true to tr("All folders")).forEach { (all, label) ->
                            val on = st.searchAllFolders == all
                            Text(label, style = MaterialTheme.typography.labelMedium, color = if (on) c.onAccent else c.inkSecondary,
                                modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(if (on) c.accent else c.tile)
                                    .clickable { actions.onSearchAllFolders(all) }.padding(horizontal = 12.dp, vertical = 7.dp))
                        }
                    }
                }
                if (searchOpen && st.query.isEmpty() && ui.recentSearches.isNotEmpty()) {
                    FlowRow(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ui.recentSearches.forEach { q ->
                            Row(Modifier.clip(RoundedCornerShape(10.dp)).background(c.tile).clickable { actions.onSearch(q) }
                                .padding(horizontal = 10.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Icon(Icons.Outlined.History, null, tint = c.inkTertiary, modifier = Modifier.size(14.dp))
                                Text(q, style = MaterialTheme.typography.labelMedium, color = c.ink)
                            }
                        }
                    }
                }
                if (ui.accounts.size > 1 && !searchOpen) {
                    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        item(key = ALL_ACCOUNTS) {
                            AccountChip(tr("All"), null, active = ui.activeId == ALL_ACCOUNTS,
                                badge = ui.accounts.sumOf { ui.unread[it.id] ?: 0 }) { actions.onAccount(ALL_ACCOUNTS) }
                        }
                        items(ui.accounts, key = { it.id }) { acc ->
                            AccountChip(acc.name.ifBlank { acc.email.substringBefore('@') }, acc.color, active = acc.id == ui.activeId,
                                badge = ui.unread[acc.id] ?: 0) { actions.onAccount(acc.id) }
                        }
                    }
                }
                // The list sits on one frosted sheet, like the desktop's list panel
                Box(Modifier.fillMaxSize().padding(top = 4.dp).clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)).background(c.surface)) {
                    PullToRefreshBox(isRefreshing = st.refreshing, onRefresh = actions.onRefresh, modifier = Modifier.fillMaxSize()) {
                        when {
                            st.loading -> SkeletonList()
                            st.error != null && st.messages.isEmpty() -> ScrollableEmpty {
                                EmptyMessage(Icons.Outlined.CloudOff, tr("Couldn’t load mail"), st.error.orEmpty(), tr("Try again"), actions.onRefresh)
                            }
                            st.messages.isEmpty() -> ScrollableEmpty {
                                when {
                                    st.searching -> EmptyMessage(Icons.Outlined.SearchOff, tr("No results"),
                                        tr("Nothing matches “${st.query}” in ${if (st.searchAllFolders) tr("All folders") else st.title}."))
                                    st.isStarred -> EmptyMessage(Icons.Outlined.StarOutline, tr("Nothing starred"), tr("Star a message to keep it here, whatever folder it’s in."))
                                    st.unified || st.folder?.role == FolderRole.INBOX -> EmptyMessage(Icons.Outlined.TaskAlt, tr("All caught up"),
                                        tr("Nothing left in your inbox. New mail shows up here."), tr("New message"), actions.onCompose)
                                    else -> EmptyMessage(Icons.Outlined.Inbox, tr("No messages"), tr("${st.title} is empty."))
                                }
                            }
                            else -> MessageList(ui, actions)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ScrollableEmpty(content: @Composable () -> Unit) {
    // Scrollable so pull-to-refresh still works on an empty list
    LazyColumn(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, contentPadding = PaddingValues(top = 96.dp)) {
        item { content() }
    }
}

@Composable
private fun SkeletonList() {
    val c = Frost.colors
    Column(Modifier.fillMaxSize().padding(top = 18.dp)) {
        repeat(7) { i ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(Modifier.size(40.dp).clip(RoundedCornerShape(20.dp)).background(c.tile))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.fillMaxWidth(if (i % 2 == 0) 0.45f else 0.6f).height(10.dp).clip(RoundedCornerShape(5.dp)).background(c.tile))
                    Box(Modifier.fillMaxWidth(if (i % 3 == 0) 0.8f else 0.7f).height(10.dp).clip(RoundedCornerShape(5.dp)).background(c.tile))
                }
            }
        }
    }
}

@Composable
private fun MessageList(ui: InboxUi, actions: InboxActions) {
    val st = ui.list
    val messages = st.messages
    val listState = rememberLazyListState()
    val nearEnd by remember { derivedStateOf { (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= listState.layoutInfo.totalItemsCount - 5 } }
    LaunchedEffect(nearEnd, messages.size) { if (nearEnd && st.canLoadMore) actions.onLoadMore() }
    val folderNames = remember(st.folders) { st.folders.associate { it.path to I18n.folderName(it) } }
    val accountNames = remember(ui.accounts) { ui.accounts.associate { it.id to (it.name.ifBlank { it.email.substringBefore('@') }) } }

    LazyColumn(state = listState, contentPadding = PaddingValues(top = 6.dp, bottom = 104.dp), modifier = Modifier.fillMaxSize()) {
        ui.update?.let { r ->
            item(key = "update") {
                InfoCard(
                    title = tr("Mailplane ${r.version} is available"),
                    body = tr("Download and install it straight from GitHub."),
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { actions.onUpdate(r) }) { Text(tr("Update"), color = Frost.colors.ink, style = MaterialTheme.typography.labelLarge) }
                        TextButton(onClick = { actions.onDismissUpdate(r) }) { Text(tr("Later"), color = Frost.colors.inkSecondary, style = MaterialTheme.typography.labelLarge) }
                    }
                }
            }
        }
        var lastDay: String? = null
        messages.forEach { m ->
            val day = if (st.searching) null else Days.label(m.date, locale = java.util.Locale(I18n.code))
            if (day != null && day != lastDay) {
                lastDay = day
                item(key = "day:$day:${m.accountId}:${m.folder}:${m.uid}") { DayHeader(day) }
            }
            item(key = "${m.accountId}:${m.folder}:${m.uid}") {
                SwipeRow(onArchive = { actions.onArchive(m) }, onDelete = { actions.onDelete(m) }) {
                    val tag = when {
                        st.unified || (st.searching && ui.activeId == ALL_ACCOUNTS) -> accountNames[m.accountId]
                        st.isStarred || (st.searching && st.searchAllFolders) -> folderNames[m.folder] ?: m.folder
                        else -> null
                    }
                    val tagIsAccount = st.unified || (st.searching && ui.activeId == ALL_ACCOUNTS)
                    MessageRow(m, compact = ui.compact, folderLabel = tag, tagIcon = if (tagIsAccount) Icons.Outlined.Person else Icons.Outlined.Folder,
                        onClick = { actions.onOpen(m) }, onStar = { actions.onStar(m) })
                }
            }
        }
        if (st.loadingMore) item(key = "more") {
            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                androidx.compose.material3.CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = Frost.colors.inkSecondary)
            }
        }
    }
}

@Composable
private fun SwipeRow(onArchive: () -> Unit, onDelete: () -> Unit, content: @Composable () -> Unit) {
    val c = Frost.colors
    val state = rememberSwipeToDismissBoxState(confirmValueChange = { v ->
        when (v) {
            SwipeToDismissBoxValue.StartToEnd -> { onArchive(); true }
            SwipeToDismissBoxValue.EndToStart -> { onDelete(); true }
            SwipeToDismissBoxValue.Settled -> false
        }
    })
    SwipeToDismissBox(
        state = state,
        backgroundContent = {
            val toArchive = state.dismissDirection == SwipeToDismissBoxValue.StartToEnd
            Row(
                Modifier.fillMaxSize().background(if (toArchive) c.accent else c.danger).padding(horizontal = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = if (toArchive) Arrangement.Start else Arrangement.End,
            ) {
                Icon(if (toArchive) Icons.Outlined.Archive else Icons.Outlined.Delete, contentDescription = tr(if (toArchive) "Archive" else "Delete"),
                    tint = if (toArchive) c.onAccent else Color.White)
            }
        },
    ) { Box(Modifier.background(c.surface)) { content() } }
}

@Composable
private fun MessageRow(m: MessageSummary, compact: Boolean, folderLabel: String?, tagIcon: ImageVector = Icons.Outlined.Folder, onClick: () -> Unit, onStar: () -> Unit) {
    val c = Frost.colors
    val unread = !m.seen
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick)
            .padding(start = 20.dp, end = 8.dp, top = if (compact) 9.dp else 12.dp, bottom = if (compact) 9.dp else 12.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = if (compact) Alignment.CenterVertically else Alignment.Top,
    ) {
        if (!compact) SenderAvatar(m.fromName, m.fromEmail, 40.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(m.fromName, style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (unread) c.ink else c.inkSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(listTime(m), style = MaterialTheme.typography.labelSmall, color = if (unread) c.inkSecondary else c.inkTertiary)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(m.subject, style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (unread) FontWeight.Medium else FontWeight.Normal,
                    color = if (unread) c.ink else c.inkSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            }
            if (!compact && (m.hasAttachments || folderLabel != null)) {
                Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (folderLabel != null) Tag(tagIcon, folderLabel)
                    if (m.hasAttachments) Tag(Icons.Outlined.AttachFile, tr("Attachment"))
                }
            }
        }
        IconButton(onClick = onStar, modifier = Modifier.size(36.dp)) {
            Icon(if (m.flagged) Icons.Outlined.Star else Icons.Outlined.StarOutline, tr(if (m.flagged) "Unstar" else "Star"),
                tint = if (m.flagged) c.accentDeep else c.inkTertiary, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun Tag(icon: ImageVector, text: String) {
    val c = Frost.colors
    Row(Modifier.clip(RoundedCornerShape(6.dp)).background(c.tile).padding(horizontal = 7.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(icon, null, tint = c.inkTertiary, modifier = Modifier.size(11.dp))
        Text(text, style = MaterialTheme.typography.labelSmall, color = c.inkSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun FolderDrawer(
    folders: List<MailFolder>,
    current: String,
    quota: StorageQuota?,
    accounts: List<Account>,
    onAccount: (String) -> Unit,
    onFolder: (String) -> Unit,
    onAddAccount: () -> Unit,
    onSettings: () -> Unit,
) {
    val c = Frost.colors
    val system = folders.filter { it.role != null }
    val custom = folders.filter { it.role == null }
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            item {
                Row(Modifier.padding(start = 8.dp, top = 12.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    BrandMark(30.dp)
                    Text("Mailplane", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, color = c.ink)
                }
            }
            system.forEachIndexed { i, f ->
                item(key = f.path) {
                    DrawerRow(roleIcon(f.role), I18n.folderName(f), selected = f.path == current,
                        badge = if (f.role == FolderRole.INBOX) f.unread else 0, accentBadge = true) { onFolder(f.path) }
                }
                // Starred sits right under the inbox
                if (i == 0) item(key = STARRED) {
                    DrawerRow(Icons.Outlined.Star, tr("Starred"), selected = current == STARRED) { onFolder(STARRED) }
                }
            }
            if (accounts.isNotEmpty()) {
                // Unified inbox: folders belong to one account — pick it first
                item { Text(tr("Accounts"), style = MaterialTheme.typography.labelMedium, color = c.inkTertiary, modifier = Modifier.padding(start = 12.dp, top = 4.dp, bottom = 6.dp)) }
                items(accounts, key = { it.id }) { acc ->
                    DrawerRow(Icons.Outlined.Inbox, acc.name.ifBlank { acc.email }, selected = false) { onAccount(acc.id) }
                }
            }
            if (custom.isNotEmpty()) {
                item { Text(tr("Folders"), style = MaterialTheme.typography.labelMedium, color = c.inkTertiary, modifier = Modifier.padding(start = 12.dp, top = 16.dp, bottom = 6.dp)) }
                items(custom, key = { it.path }) { f ->
                    DrawerRow(Icons.Outlined.Folder, I18n.folderName(f), selected = f.path == current, badge = f.unread) { onFolder(f.path) }
                }
            }
        }
        Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            if (quota != null) StorageBar(quota, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp))
            DrawerRow(Icons.Outlined.Add, tr("Add account"), selected = false, onClick = onAddAccount)
            DrawerRow(Icons.Outlined.Settings, tr("Settings"), selected = false, onClick = onSettings)
        }
    }
}

@Composable
private fun DrawerRow(icon: ImageVector, label: String, selected: Boolean, badge: Int = 0, accentBadge: Boolean = false, onClick: () -> Unit) {
    val c = Frost.colors
    Row(
        Modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(12.dp)).background(if (selected) c.raised else Color.Transparent)
            .clickable(onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(icon, contentDescription = null, tint = if (selected) c.ink else c.inkTertiary, modifier = Modifier.size(20.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = if (selected) c.ink else c.inkSecondary,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal, modifier = Modifier.weight(1f))
        if (badge > 0) {
            if (accentBadge) Text(badge.toString(), style = MaterialTheme.typography.labelMedium, color = c.onAccent,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(c.accent).padding(horizontal = 8.dp, vertical = 2.dp))
            else Text(badge.toString(), style = MaterialTheme.typography.labelMedium, color = c.inkSecondary)
        }
        Spacer(Modifier.width(2.dp))
    }
}

private fun roleIcon(role: FolderRole?): ImageVector = when (role) {
    FolderRole.INBOX -> Icons.Outlined.Inbox
    FolderRole.SENT -> Icons.AutoMirrored.Outlined.Send
    FolderRole.DRAFTS -> Icons.Outlined.Drafts
    FolderRole.TRASH -> Icons.Outlined.Delete
    FolderRole.SPAM -> Icons.Outlined.Report
    FolderRole.ARCHIVE -> Icons.Outlined.Archive
    null -> Icons.Outlined.Folder
}

// Follow the interface language (German → 17:31, English → 5:31 PM)
private val timeFmt get() = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(java.util.Locale(I18n.code))
private val dayFmt get() = DateTimeFormatter.ofPattern("d MMM", java.util.Locale(I18n.code))

/** Time under a day header: clock time this week, short date before that. */
internal fun listTime(m: MessageSummary): String {
    val d = m.date?.atZone(ZoneId.systemDefault()) ?: return ""
    return if (d.toLocalDate().isAfter(LocalDate.now().minusDays(7))) d.format(timeFmt) else d.format(dayFmt)
}

/** Kept for other screens (message header etc.). */
internal fun shortDate(m: MessageSummary): String {
    val d = m.date?.atZone(ZoneId.systemDefault()) ?: return ""
    val today = LocalDate.now()
    return when (d.toLocalDate()) {
        today -> d.format(timeFmt)
        today.minusDays(1) -> tr("Yesterday")
        else -> d.format(dayFmt)
    }
}
