package com.powersync.lynx.showcase;

import android.app.Activity;
import android.content.Intent;
import java.util.HashMap;
import java.util.Map;

final class HostConfig {
  private HostConfig() {}

  static String device(Activity activity) {
    return first(extra(activity, "device"), activity.getString(R.string.demo_device), "android");
  }

  static String demoApiUrl(Activity activity) {
    return first(
        extra(activity, "demoApiUrl"),
        activity.getString(R.string.demo_api_url),
        "http://10.0.2.2:8081");
  }

  static String powersyncUrl(Activity activity) {
    return first(
        extra(activity, "powersyncUrl"),
        activity.getString(R.string.powersync_url),
        "http://10.0.2.2:8080");
  }

  static Map<String, Object> globalProps(Activity activity) {
    Map<String, Object> props = new HashMap<>();
    props.put("device", device(activity));
    props.put("demoApiUrl", demoApiUrl(activity));
    props.put("powersyncUrl", powersyncUrl(activity));
    return props;
  }

  private static String extra(Activity activity, String key) {
    Intent intent = activity.getIntent();
    if (intent == null) {
      return null;
    }
    return intent.getStringExtra(key);
  }

  private static String first(String... values) {
    for (String value : values) {
      if (value == null) {
        continue;
      }
      String trimmed = value.trim();
      if (!trimmed.isEmpty()) {
        return trimmed;
      }
    }
    return "";
  }
}
