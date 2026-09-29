@file:OptIn(ExperimentalMaterial3Api::class)

package app.mailplane.android.ui.inbox

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Drafts
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Report
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Send
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material3.CircularProgressIndicator
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
import app.mailplane.android.ui.MailViewModel
import app.mailplane.android.ui.components.Avatar
import app.mailplane.android.ui.components.BrandMark
import app.mailplane.android.ui.components.Pill
import app.mailplane.android.ui.components.accentWash
import app.mailplane.android.ui.theme.Frost
import app.mailplane.core.FolderRole
import app.mailplane.core.MailFolder
import app.mailplane.core.MessageSummary
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Composable
fun InboxScreen(
    vm: MailViewModel,
    snackbar: SnackbarHostState,
    onOpen: (MessageSummary) -> Unit,
    onCompose: () -> Unit,
    onAddAccount: () -> Unit,
    onSettings: () -> Unit,
) {
    val c = Frost.colors
    val accounts by vm.accounts.collectAsState()
    val activeId by vm.activeAccountId.collectAsState()
    val st by vm.list.collectAsState()
    val unread by vm.unread.collectAsState()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var searchOpen by remember { mutableStateOf(false) }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = c.surface, drawerShape = RoundedCornerShape(topEnd = 24.dp, bottomEnd = 24.dp)) {
                FolderDrawer(
                    folders = st.folders, current = st.folderPath,
                    onFolder = { vm.openFolder(it); scope.launch { drawer.close() } },
                    onAddAccount = { scope.launch { drawer.close() }; onAddAccount() },
                    onSettings = { scope.launch { drawer.close() }; onSettings() },
                )
            }
        },
    ) {
        Scaffold(
            containerColor = c.canvas,
            snackbarHost = { SnackbarHost(snackbar) },
            floatingActionButton = {
                ExtendedFloatingActionButton(
                    onClick = onCompose, containerColor = c.accent, contentColor = c.onAccent,
                    shape = RoundedCornerShape(16.dp),
                    icon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                    text = { Text("New message") },
                )
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).background(accentWash())) {
                // Header: menu · folder title · search
                Row(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 4.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { scope.launch { drawer.open() } }) { Icon(Icons.Outlined.Menu, "Folders", tint = c.ink) }
                    if (searchOpen) {
                        TextField(
                            value = st.query, onValueChange = vm::search, singleLine = true,
                            placeholder = { Text("Search ${st.folder?.name ?: ""}") },
                            modifier = Modifier.weight(1f).padding(end = 4.dp), shape = RoundedCornerShape(14.dp),
                            colors = TextFieldDefaults.colors(focusedContainerColor = c.tile, unfocusedContainerColor = c.tile,
                                focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = c.ink),
                        )
                        IconButton(onClick = { searchOpen = false; vm.search("") }) { Icon(Icons.Outlined.Close, "Close search", tint = c.ink) }
                    } else {
                        Column(Modifier.weight(1f).padding(start = 4.dp)) {
                            Text(st.folder?.name ?: "Inbox", style = MaterialTheme.typography.headlineSmall, color = c.ink)
                            val u = st.folder?.let { if (it.role == FolderRole.INBOX) unread[activeId] ?: it.unread else it.unread } ?: 0
                            if (u > 0) Text("$u unread", style = MaterialTheme.typography.bodySmall, color = c.inkSecondary)
                        }
                        IconButton(onClick = { searchOpen = true }) { Icon(Icons.Outlined.Search, "Search", tint = c.ink) }
                    }
                }
                // Account pills (like the desktop title bar)
                if (accounts.size > 1) {
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(accounts, key = { it.id }) { acc ->
                            Pill(acc.name.ifBlank { acc.email }, selected = acc.id == activeId, dotHex = acc.color,
                                badge = unread[acc.id] ?: 0) { vm.switchAccount(acc.id) }
                        }
                    }
                }
                PullToRefreshBox(isRefreshing = st.refreshing, onRefresh = vm::refresh, modifier = Modifier.fillMaxSize()) {
                    when {
                        st.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = c.inkSecondary, strokeWidth = 2.dp)
                        }
                        st.error != null && st.messages.isEmpty() -> EmptyState("Couldn't load mail", st.error!!, "Try again") { vm.refresh() }
                        st.messages.isEmpty() -> EmptyState(
                            if (st.searching) "No results" else "All caught up",
                            if (st.searching) "Nothing matches “${st.query}”" else "Nothing in ${st.folder?.name ?: "this folder"}",
                        )
                        else -> MessageList(vm, st.messages, st.canLoadMore, st.loadingMore, onOpen)
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageList(
    vm: MailViewModel,
    messages: List<MessageSummary>,
    canLoadMore: Boolean,
    loadingMore: Boolean,
    onOpen: (MessageSummary) -> Unit,
) {
    val listState = rememberLazyListState()
    val nearEnd by remember { derivedStateOf { (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= messages.size - 5 } }
    LaunchedEffect(nearEnd, messages.size) { if (nearEnd && canLoadMore) vm.loadMessages() }

    LazyColumn(state = listState, contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxSize()) {
        items(messages, key = { "${it.folder}:${it.uid}" }) { m ->
            SwipeRow(m, onArchive = { vm.archive(m) }, onDelete = { vm.delete(m) }) {
                MessageRow(m, onClick = { onOpen(m) }, onStar = { vm.toggleFlag(m) })
            }
        }
        if (loadingMore) item {
            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = Frost.colors.inkSecondary)
            }
        }
    }
}

@Composable
private fun SwipeRow(m: MessageSummary, onArchive: () -> Unit, onDelete: () -> Unit, content: @Composable () -> Unit) {
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
                Modifier.fillMaxSize().clip(RoundedCornerShape(16.dp)).background(if (toArchive) c.accent else c.danger).padding(horizontal = 22.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = if (toArchive) Arrangement.Start else Arrangement.End,
            ) {
                Icon(if (toArchive) Icons.Outlined.Archive else Icons.Outlined.Delete, contentDescription = null,
                    tint = if (toArchive) c.onAccent else Color.White)
            }
        },
    ) { content() }
}

@Composable
private fun MessageRow(m: MessageSummary, onClick: () -> Unit, onStar: () -> Unit) {
    val c = Frost.colors
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(c.surface).clickable(onClick = onClick)
            .padding(start = 14.dp, end = 6.dp, top = 12.dp, bottom = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(m.fromName, 40.dp)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(m.fromName, style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (m.seen) FontWeight.Normal else FontWeight.SemiBold,
                    color = if (m.seen) c.inkSecondary else c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(shortDate(m), style = MaterialTheme.typography.labelSmall, color = if (m.seen) c.inkTertiary else c.inkSecondary)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (!m.seen) Box(Modifier.size(7.dp).clip(CircleShape).background(c.accentDeep))
                Text(m.subject, style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (m.seen) FontWeight.Normal else FontWeight.Medium,
                    color = if (m.seen) c.inkSecondary else c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (m.hasAttachments) Icon(Icons.Outlined.AttachFile, "Has attachment", tint = c.inkTertiary, modifier = Modifier.size(14.dp))
            }
        }
        IconButton(onClick = onStar, modifier = Modifier.size(36.dp)) {
            Icon(if (m.flagged) Icons.Outlined.Star else Icons.Outlined.StarOutline, if (m.flagged) "Unstar" else "Star",
                tint = if (m.flagged) c.accentDeep else c.inkTertiary, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun EmptyState(title: String, body: String, action: String? = null, onAction: () -> Unit = {}) {
    val c = Frost.colors
    // Scrollable so pull-to-refresh still works on an empty list
    LazyColumn(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, contentPadding = PaddingValues(top = 120.dp)) {
        item {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(32.dp)) {
                Box(Modifier.size(56.dp).clip(RoundedCornerShape(16.dp)).background(c.tile), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Inbox, null, tint = c.inkSecondary)
                }
                Text(title, style = MaterialTheme.typography.titleLarge, color = c.ink)
                Text(body, style = MaterialTheme.typography.bodyMedium, color = c.inkTertiary)
                if (action != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(action, color = c.ink, style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(c.tile).clickable(onClick = onAction).padding(horizontal = 16.dp, vertical = 10.dp))
                }
            }
        }
    }
}

@Composable
private fun FolderDrawer(
    folders: List<MailFolder>,
    current: String,
    onFolder: (String) -> Unit,
    onAddAccount: () -> Unit,
    onSettings: () -> Unit,
) {
    val c = Frost.colors
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        item {
            Row(Modifier.padding(start = 8.dp, top = 12.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BrandMark(32.dp)
                Text("Mailplane", style = MaterialTheme.typography.titleLarge, color = c.ink)
            }
        }
        items(folders, key = { it.path }) { f ->
            DrawerRow(roleIcon(f.role), f.name, selected = f.path == current, badge = if (f.role == FolderRole.INBOX || f.role == null) f.unread else 0) { onFolder(f.path) }
        }
        item { Spacer(Modifier.height(12.dp)) }
        item { DrawerRow(Icons.Outlined.Add, "Add account", selected = false, onClick = onAddAccount) }
        item { DrawerRow(Icons.Outlined.Settings, "Settings", selected = false, onClick = onSettings) }
    }
}

@Composable
private fun DrawerRow(icon: ImageVector, label: String, selected: Boolean, badge: Int = 0, onClick: () -> Unit) {
    val c = Frost.colors
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(if (selected) c.raised else Color.Transparent)
            .clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(if (selected) c.tileActive else c.tile), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = if (selected) c.ink else c.inkSecondary, modifier = Modifier.size(18.dp))
        }
        Text(label, style = MaterialTheme.typography.bodyMedium, color = if (selected) c.ink else c.inkSecondary,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal, modifier = Modifier.weight(1f))
        if (badge > 0) Text(badge.toString(), style = MaterialTheme.typography.labelMedium, color = c.onAccent,
            modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(c.accent).padding(horizontal = 8.dp, vertical = 2.dp))
        Spacer(Modifier.width(4.dp))
    }
}

private fun roleIcon(role: FolderRole?): ImageVector = when (role) {
    FolderRole.INBOX -> Icons.Outlined.Inbox
    FolderRole.SENT -> Icons.Outlined.Send
    FolderRole.DRAFTS -> Icons.Outlined.Drafts
    FolderRole.TRASH -> Icons.Outlined.Delete
    FolderRole.SPAM -> Icons.Outlined.Report
    FolderRole.ARCHIVE -> Icons.Outlined.Archive
    null -> Icons.Outlined.Folder
}

private val timeFmt = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
private val dayFmt = DateTimeFormatter.ofPattern("d MMM")

internal fun shortDate(m: MessageSummary): String {
    val d = m.date?.atZone(ZoneId.systemDefault()) ?: return ""
    val today = LocalDate.now()
    return when (d.toLocalDate()) {
        today -> d.format(timeFmt)
        today.minusDays(1) -> "Yesterday"
        else -> d.format(dayFmt)
    }
}

