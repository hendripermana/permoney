import { Controller } from "@hotwired/stimulus";

// Shadcn-style Tabs Controller
// Clean, simple, and reliable tab switching with keyboard navigation
export default class extends Controller {
  static targets = ["trigger", "panel", "tablist"];
  static values = {
    default: String,
    urlParam: String,
  };

  connect() {
    // Set initial active tab
    const urlParams = new URLSearchParams(window.location.search);
    const urlTab = this.urlParamValue && urlParams.get(this.urlParamValue);
    const activeValue = urlTab || this.defaultValue;

    if (activeValue) {
      this.activateTab(activeValue, false);
    }

    // Add keyboard navigation
    this.element.addEventListener("keydown", this.handleKeydown.bind(this));
  }

  disconnect() {
    this.element.removeEventListener("keydown", this.handleKeydown.bind(this));
  }

  // Handle tab selection
  selectTab(event) {
    // Only prevent default for buttons, let the event bubble normally
    if (event.currentTarget.tagName === "BUTTON") {
      event.preventDefault();
    }

    const trigger = event.currentTarget;
    const value = trigger.dataset.tabValue;

    if (value) {
      this.activateTab(value, true);
    }
  }

  // Activate a specific tab
  activateTab(value, updateUrl = true) {
    // Update triggers
    this.triggerTargets.forEach((trigger) => {
      const isActive = trigger.dataset.tabValue === value;
      
      trigger.setAttribute("aria-selected", isActive ? "true" : "false");
      trigger.setAttribute("tabindex", isActive ? "0" : "-1");
      
      // Update classes
      if (isActive) {
        trigger.classList.add(
          "bg-white",
          "theme-dark:bg-gray-700",
          "text-primary",
          "shadow-sm"
        );
        trigger.classList.remove("text-secondary", "hover:bg-surface-inset-hover");
      } else {
        trigger.classList.remove(
          "bg-white",
          "theme-dark:bg-gray-700",
          "text-primary",
          "shadow-sm"
        );
        trigger.classList.add("text-secondary", "hover:bg-surface-inset-hover");
      }
    });

    // Update panels
    this.panelTargets.forEach((panel) => {
      const isActive = panel.dataset.tabValue === value;
      
      if (isActive) {
        panel.classList.remove("hidden");
        panel.setAttribute("tabindex", "0");
      } else {
        panel.classList.add("hidden");
        panel.setAttribute("tabindex", "-1");
      }
    });

    // Update URL if enabled
    if (updateUrl && this.urlParamValue) {
      const url = new URL(window.location.href);
      url.searchParams.set(this.urlParamValue, value);
      window.history.replaceState({}, "", url);
    }
  }

  // Keyboard navigation (Arrow keys)
  handleKeydown(event) {
    // Only handle keyboard events on tab triggers
    if (!event.target.hasAttribute("role") || event.target.getAttribute("role") !== "tab") {
      return;
    }

    const triggers = this.triggerTargets;
    const currentIndex = triggers.indexOf(event.target);
    let newIndex;

    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        newIndex = currentIndex > 0 ? currentIndex - 1 : triggers.length - 1;
        break;
      case "ArrowRight":
        event.preventDefault();
        newIndex = currentIndex < triggers.length - 1 ? currentIndex + 1 : 0;
        break;
      case "Home":
        event.preventDefault();
        newIndex = 0;
        break;
      case "End":
        event.preventDefault();
        newIndex = triggers.length - 1;
        break;
      default:
        return;
    }

    // Rails 8.1: Remove redundant undefined check
    // newIndex is always set in switch cases above, or function returns early
    // Focus and activate new tab
    if (triggers[newIndex]) {
      triggers[newIndex].focus();
      const value = triggers[newIndex].dataset.tabValue;
      this.activateTab(value, true);
    }
  }
}
