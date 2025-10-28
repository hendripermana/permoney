import { Controller } from "@hotwired/stimulus";

// Connects to data-controller="tabs--components"
export default class extends Controller {
  static classes = ["navBtnActive", "navBtnInactive"];
  static targets = ["panel", "navBtn"];
  static values = { sessionKey: String, urlParamKey: String };

  show(e) {
    // Prevent default button behavior
    e.preventDefault();
    e.stopPropagation();
    
    const btn = e.currentTarget.closest("button");
    if (!btn) return;
    
    const selectedTabId = btn.dataset.id;
    if (!selectedTabId) return;

    this.navBtnTargets.forEach((navBtn) => {
      if (navBtn.dataset.id === selectedTabId) {
        navBtn.classList.add(...this.navBtnActiveClasses);
        navBtn.classList.remove(...this.navBtnInactiveClasses);
      } else {
        navBtn.classList.add(...this.navBtnInactiveClasses);
        navBtn.classList.remove(...this.navBtnActiveClasses);
      }
    });

    this.panelTargets.forEach((panel) => {
      if (panel.dataset.id === selectedTabId) {
        panel.classList.remove("hidden");
      } else {
        panel.classList.add("hidden");
      }
    });

    if (this.urlParamKeyValue) {
      const url = new URL(window.location.href);
      url.searchParams.set(this.urlParamKeyValue, selectedTabId);
      window.history.replaceState({}, "", url);
    }

    // Update URL with the selected tab
    if (this.sessionKeyValue) {
      this.#updateSessionPreference(selectedTabId);
    }
  } 

  #updateSessionPreference(selectedTabId) {
    fetch("/current_session", {
      method: "PUT",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-Token": document.querySelector('[name="csrf-token"]').content,
        Accept: "application/json",
      },
      body: new URLSearchParams({
        "current_session[tab_key]": this.sessionKeyValue,
        "current_session[tab_value]": selectedTabId,
      }).toString(),
    });
  }
}
