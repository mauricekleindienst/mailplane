package app.mailplane.core

/** Compares release versions like "0.2.0", "v1.0.0" or "1.0.0-beta.2". */
object Versions {
    fun compare(a: String, b: String): Int {
        val x = parse(a)
        val y = parse(b)
        for (i in 0 until maxOf(x.first.size, y.first.size)) {
            val d = x.first.getOrElse(i) { 0 } - y.first.getOrElse(i) { 0 }
            if (d != 0) return if (d > 0) 1 else -1
        }
        // A final release beats its pre-releases: 1.0.0 > 1.0.0-beta
        return when {
            x.second.isNotEmpty() && y.second.isEmpty() -> -1
            x.second.isEmpty() && y.second.isNotEmpty() -> 1
            else -> x.second.compareTo(y.second).coerceIn(-1, 1)
        }
    }

    fun isNewer(candidate: String, current: String): Boolean = compare(candidate, current) > 0

    private fun parse(v: String): Pair<List<Int>, String> {
        val clean = v.trim().removePrefix("v").removePrefix("V")
        val main = clean.substringBefore('-')
        val pre = if ('-' in clean) clean.substringAfter('-') else ""
        return main.split('.').map { it.toIntOrNull() ?: 0 } to pre
    }
}
