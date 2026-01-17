import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static values = {
    storageKey: String,
  };

  connect() {
    this.restore();
  }

  stash() {
    if (!this.storageKeyValue) return;
    if (!window.sessionStorage) return;

    const data = {};
    this.element
      .querySelectorAll("input, select, textarea")
      .forEach((element) => {
        if (!element.name || element.disabled) return;
        if (element.type === "file" || element.type === "password") return;

        if (element.type === "checkbox") {
          data[element.name] = element.checked;
        } else if (element.type === "radio") {
          if (element.checked) data[element.name] = element.value;
        } else {
          data[element.name] = element.value;
        }
      });

    sessionStorage.setItem(this.storageKeyValue, JSON.stringify(data));
  }

  restore() {
    if (!this.storageKeyValue) return;
    if (!window.sessionStorage) return;

    const raw = sessionStorage.getItem(this.storageKeyValue);
    if (!raw) return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (_error) {
      sessionStorage.removeItem(this.storageKeyValue);
      return;
    }

    Object.entries(data).forEach(([name, value]) => {
      const escapedName = window.CSS && CSS.escape ? CSS.escape(name) : name.replace(/\"/g, "\\\"");
      const selector = `[name="${escapedName}"]`;
      const elements = this.element.querySelectorAll(selector);
      if (!elements.length) return;

      elements.forEach((element) => {
        if (element.type === "checkbox") {
          element.checked = Boolean(value);
        } else if (element.type === "radio") {
          element.checked = element.value === value;
        } else {
          element.value = value;
        }
      });
    });

    sessionStorage.removeItem(this.storageKeyValue);
  }
}
