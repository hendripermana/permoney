import { Controller } from "@hotwired/stimulus";

// Gives immediate feedback on sync-all clicks without blocking submission.
// Adds a lightweight spinner effect and busy state to reduce double clicks.
export default class extends Controller {
  start() {
    this.element.setAttribute("aria-busy", "true");
    this.element.classList.add("opacity-70");

    const icon = this.element.querySelector("svg");
    if (icon) {
      icon.classList.add("animate-spin");
    }
  }
}
