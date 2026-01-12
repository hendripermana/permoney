import { Controller } from "@hotwired/stimulus";

// data-controller="checkbox-toggle"
// - Add data-checkbox-toggle-target="checkbox" to the checkbox input
// - Wrap dependent fields in an element with data-checkbox-toggle-target="section"
// This controller shows/hides the section and disables/enables its inputs
// based on the checkbox state, keeping the form semantics intact.
export default class extends Controller {
  static targets = ["checkbox", "section", "selectionEntry", "toggleButton"];

  connect() {
    if (!this.hasSelectionEntryTarget) {
      this.update();
    }
  }

  toggle() {
    if (this.hasSelectionEntryTarget) {
      this.toggleSelectionEntries();
      return;
    }

    this.update();
  }

  update() {
    const checked = this.hasCheckboxTarget ? this.checkboxTarget.checked : false;
    this.sectionTargets.forEach((section) => {
      // Toggle visibility
      if (checked) {
        section.classList.remove("hidden");
      } else {
        section.classList.add("hidden");
      }

      // Toggle interactivity
      section.querySelectorAll("input, select, textarea").forEach((el) => {
        el.disabled = !checked;
      });
    });
  }

  toggleSelectionEntries() {
    if (this.selectionEntryTargets.length === 0) return;

    const shouldShow = this.selectionEntryTargets[0].classList.contains("hidden");

    this.selectionEntryTargets.forEach((el) => {
      if (shouldShow) {
        el.classList.remove("hidden");
      } else {
        el.classList.add("hidden");
      }
    });

    if (!shouldShow) {
      let bulkSelectElement = null;
      if (this.element.matches("[data-controller~='bulk-select']")) {
        bulkSelectElement = this.element;
      } else {
        bulkSelectElement =
          this.element.querySelector("[data-controller~='bulk-select']") ||
          this.element.closest("[data-controller~='bulk-select']") ||
          document.querySelector("[data-controller~='bulk-select']");
      }

      if (bulkSelectElement) {
        const bulkSelectController = this.application.getControllerForElementAndIdentifier(
          bulkSelectElement,
          "bulk-select"
        );
        if (bulkSelectController) {
          bulkSelectController.deselectAll();
        }
      }
    }

    if (this.hasToggleButtonTarget) {
      this.toggleButtonTarget.classList.toggle("bg-surface", shouldShow);
    }
  }
}
