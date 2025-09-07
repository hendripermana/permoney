import { Controller } from "@hotwired/stimulus"

// data-controller="checkbox-toggle"
// - Add data-checkbox-toggle-target="checkbox" to the checkbox input
// - Wrap dependent fields in an element with data-checkbox-toggle-target="section"
// This controller shows/hides the section and disables/enables its inputs
// based on the checkbox state, keeping the form semantics intact.
export default class extends Controller {
  static targets = ["checkbox", "section"]

  connect() {
    this.update()
  }

  toggle() {
    this.update()
  }

  update() {
    const checked = this.hasCheckboxTarget ? this.checkboxTarget.checked : false
    this.sectionTargets.forEach(section => {
      // Toggle visibility
      if (checked) {
        section.classList.remove("hidden")
      } else {
        section.classList.add("hidden")
      }

      // Toggle interactivity
      section.querySelectorAll("input, select, textarea").forEach((el) => {
        el.disabled = !checked
      })
    })
  }
}

