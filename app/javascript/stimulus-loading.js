// Lightweight replacement for '@hotwired/stimulus-loading' for Importmap
// - Eager-loads and registers all controllers pinned under a given prefix
// - Mirrors Rails' naming rules (nested paths -> --, underscores -> -)

export function eagerLoadControllersFrom(prefix, application) {
  try {
    const importmapScript = document.querySelector('script[type="importmap"]');
    if (!importmapScript) return;

    const { imports = {} } = JSON.parse(importmapScript.textContent || "{}");
    const specifiers = Object.keys(imports).filter((key) =>
      key.startsWith(`${prefix}/`),
    );

    specifiers.forEach(async (specifier) => {
      try {
        const module = await import(specifier);
        const controller = module?.default;
        if (!controller) return;

        const identifier = specifier
          .replace(new RegExp(`^${prefix}/`), "")
          .replace(/_controller(\.js)?$/, "")
          .replace(/\//g, "--")
          .replace(/_/g, "-");

        application.register(identifier, controller);
      } catch (e) {
        // Keep the app booting; log for visibility
        console.error(`Failed to register controller: ${specifier}`, e);
      }
    });
  } catch (e) {
    console.error("Failed to parse importmap for controller loading", e);
  }
}

// Optional stub for API compatibility; not used in this app
export function lazyLoadControllersFrom() {
  // No-op in this lightweight implementation
}
