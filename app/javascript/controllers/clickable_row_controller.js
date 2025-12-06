import { Controller } from "@hotwired/stimulus";

/**
 * Makes table rows clickable to navigate to a URL.
 * Excludes certain cells (like action buttons) from triggering navigation.
 *
 * Usage:
 *   <tr data-controller="clickable-row"
 *       data-clickable-row-url-value="/path/to/detail">
 *     <td data-clickable-row-target="cell">Clickable content</td>
 *     <td data-clickable-row-target="exclude">Actions (not clickable)</td>
 *   </tr>
 */
export default class extends Controller {
  static targets = ["cell", "exclude"];
  static values = { url: String };

  connect() {
    this.boundClickHandler = this.handleClick.bind(this);

    // Add click listeners to clickable cells
    this.cellTargets.forEach((cell) => {
      cell.addEventListener("click", this.boundClickHandler);
    });
  }

  disconnect() {
    this.cellTargets.forEach((cell) => {
      cell.removeEventListener("click", this.boundClickHandler);
    });
  }

  handleClick(event) {
    // Don't navigate if clicking on a link, button, or interactive element
    const target = event.target;
    const interactiveElements = ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"];

    if (interactiveElements.includes(target.tagName)) {
      return;
    }

    // Check if click is inside an excluded element
    if (this.hasExcludeTarget) {
      for (const exclude of this.excludeTargets) {
        if (exclude.contains(target)) {
          return;
        }
      }
    }

    // Navigate using Turbo for SPA-like experience
    if (this.hasUrlValue && this.urlValue) {
      event.preventDefault();
      window.Turbo.visit(this.urlValue);
    }
  }
}
