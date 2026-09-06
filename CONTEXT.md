# Lynx PowerSync Client

Ubiquitous language for the Lynx PowerSync Client spec. Implementation, version pins, and vendor package names do not belong here except as the thing being named.

## Product

**Client**:
The Lynx PowerSync SDK this spec describes. App code imports it. One package, one JavaScript surface.
_Avoid_: bridge (as the product), wrapper, plugin, native SDK (as the product)

**Adapter**:
The platform implementation of PowerSync’s `DBAdapter`: native SQLite plus the PowerSync SQLite core on iOS, Android, Windows, and macOS; the official Web SDK behind the Host helper on Lynx-for-Web.
_Avoid_: native SDK, bridge (when meaning this)

**Native Module**:
The Lynx host hook the Adapter uses. JSON-serializable arguments and callbacks on the background thread. Not the public API.
_Avoid_: JS facade, Client

**Host helper**:
JavaScript that runs in the Lynx-for-Web host page and maps Native Module calls onto the official Web SDK.
_Avoid_: Web SDK (the official package), Lynx bundle

**Connector**:
App-supplied `fetchCredentials` and `uploadData`. Same object official PowerSync JavaScript uses. Lives in app JavaScript.
_Avoid_: backend, PowerSync Service, session token (the PowerSync JWT is what `fetchCredentials` returns)

**Schema**:
Client-side SQLite views declared in app code (`Schema`, `Table`, `column`) and applied at open. Not a migration, not the Postgres schema.
_Avoid_: Postgres schema, migration
