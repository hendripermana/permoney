import { Controller } from "@hotwired/stimulus"

// Connects to data-controller="conditional-fields"
export default class extends Controller {
  static targets = ["field", "trigger"]
  static values = { trigger: String }

  connect() {
    this.showHideFields()
  }

  showHideFields() {
    const triggerEl = this.hasTriggerTarget ? this.triggerTarget : this.element.querySelector('select')
    const selectedValue = triggerEl ? triggerEl.value : null

    this.fieldTargets.forEach(field => {
      const showWhen = field.dataset.showWhen
      const controls = field.querySelectorAll('input, select, textarea')

      if (showWhen === selectedValue) {
        field.style.display = "flex"
        controls.forEach(input => { input.disabled = false })
      } else {
        field.style.display = "none"
        controls.forEach(input => { input.disabled = true })
      }
    })
  }

  // Called when the trigger select changes
  triggerChanged() {
    this.showHideFields()
  }
}
