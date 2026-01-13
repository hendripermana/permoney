import { Controller } from "@hotwired/stimulus";

// Connects to data-controller="app-layout"
export default class extends Controller {
  static targets = ["leftSidebar", "mobileSidebar", "bottomNav"];
  static values = {
    userId: String,
  };
  static classes = [
    "expandedSidebar",
    "collapsedSidebar",
    "expandedTransition",
    "collapsedTransition",
  ];

  connect() {
    this.#updateBottomNavHeight();
    this.boundHandleResize = this.#updateBottomNavHeight.bind(this);
    window.addEventListener("resize", this.boundHandleResize);

    if (this.hasBottomNavTarget && "ResizeObserver" in window) {
      this.bottomNavObserver = new ResizeObserver(() => {
        this.#updateBottomNavHeight();
      });
      this.bottomNavObserver.observe(this.bottomNavTarget);
    }
  }

  disconnect() {
    window.removeEventListener("resize", this.boundHandleResize);
    if (this.bottomNavObserver) {
      this.bottomNavObserver.disconnect();
      this.bottomNavObserver = null;
    }
    this.#setBottomNavHeight(0);
  }

  openMobileSidebar() {
    this.mobileSidebarTarget.classList.remove("hidden");
  }

  closeMobileSidebar() {
    this.mobileSidebarTarget.classList.add("hidden");
  }

  toggleLeftSidebar() {
    const isOpen = this.leftSidebarTarget.classList.contains("w-full");
    this.#updateUserPreference("show_sidebar", !isOpen);
    this.#toggleSidebarWidth(this.leftSidebarTarget, isOpen);
  }

  #toggleSidebarWidth(el, isCurrentlyOpen) {
    if (isCurrentlyOpen) {
      el.classList.remove(...this.expandedSidebarClasses);
      el.classList.add(...this.collapsedSidebarClasses);
    } else {
      el.classList.add(...this.expandedSidebarClasses);
      el.classList.remove(...this.collapsedSidebarClasses);
    }
  }

  #updateUserPreference(field, value) {
    fetch(`/users/${this.userIdValue}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-Token": document.querySelector('[name="csrf-token"]').content,
        Accept: "application/json",
      },
      body: new URLSearchParams({
        [`user[${field}]`]: value,
      }).toString(),
    });
  }

  #updateBottomNavHeight() {
    const height = this.hasBottomNavTarget ? this.bottomNavTarget.offsetHeight : 0;
    this.#setBottomNavHeight(height);
  }

  #setBottomNavHeight(height) {
    const safeHeight = Number.isFinite(height) ? height : 0;
    document.documentElement.style.setProperty("--bottom-nav-h", `${safeHeight}px`);
  }
}
