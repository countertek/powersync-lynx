package com.powersync.lynx.showcase;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.SocketTimeoutException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

/** Pure JVM checks for idle-complete /sync/stream body reads (no device required). */
public class ShowcaseLynxHttpServiceTest {
  @Test
  public void syncStreamUrlIsLongLived() {
    assertTrue(ShowcaseLynxHttpService.isSyncStreamUrl("http://10.0.2.2:8080/sync/stream"));
    assertTrue(
        ShowcaseLynxHttpService.looksLikeLongLivedStream(
            "http://10.0.2.2:8080/sync/stream", Collections.emptyMap()));
  }

  @Test
  public void chunkedNdjsonWithoutLengthIsLongLived() {
    Map<String, String> headers = new HashMap<>();
    headers.put("Transfer-Encoding", "chunked");
    headers.put("Content-Type", "application/x-ndjson");
    assertTrue(ShowcaseLynxHttpService.looksLikeLongLivedStream("http://host/other", headers));
  }

  @Test
  public void fixedLengthJsonIsNotLongLived() {
    Map<String, String> headers = new HashMap<>();
    headers.put("Content-Length", "12");
    headers.put("Content-Type", "application/json");
    assertFalse(ShowcaseLynxHttpService.looksLikeLongLivedStream("http://host/token", headers));
  }

  @Test
  public void idleTimeoutReturnsBufferedBytesForLongLivedStream() throws IOException {
    byte[] first = "{\"checkpoint\":1}\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    InputStream stallAfterFirst =
        new InputStream() {
          private final ByteArrayInputStream head = new ByteArrayInputStream(first);
          private boolean stalled;

          @Override
          public int read(byte[] b, int off, int len) throws IOException {
            int n = head.read(b, off, len);
            if (n >= 0) {
              return n;
            }
            if (!stalled) {
              stalled = true;
              throw new SocketTimeoutException("timeout");
            }
            return -1;
          }

          @Override
          public int read() throws IOException {
            int n = head.read();
            if (n >= 0) {
              return n;
            }
            if (!stalled) {
              stalled = true;
              throw new SocketTimeoutException("timeout");
            }
            return -1;
          }
        };

    byte[] got =
        ShowcaseLynxHttpService.readUntilIdleOrEof(stallAfterFirst, true, "http://h/sync/stream");
    assertArrayEquals(first, got);
  }
}
