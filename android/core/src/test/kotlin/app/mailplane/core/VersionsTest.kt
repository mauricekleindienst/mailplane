package app.mailplane.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VersionsTest {
    @Test fun `orders release versions numerically`() {
        assertEquals(1, Versions.compare("0.2.0", "0.1.9"))
        assertEquals(-1, Versions.compare("0.1.0", "0.10.0"))
        assertEquals(0, Versions.compare("v0.1.0", "0.1.0"))
        assertEquals(0, Versions.compare("1.0", "1.0.0"))
    }

    @Test fun `a final release is newer than its pre-releases`() {
        assertTrue(Versions.isNewer("1.0.0", "1.0.0-beta.2"))
        assertFalse(Versions.isNewer("1.0.0-beta.2", "1.0.0"))
    }
}
