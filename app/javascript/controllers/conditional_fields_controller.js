import { Controller } from "@hotwired/stimulus"

// Connects to data-controller="conditional-fields"
export default class extends Controller {
  static targets = ["field"]
  static values = { trigger: String }

  connect() {
    this.showHideFields()
  }

  showHideFields() {
    const triggerValue = this.triggerValue
    const selectedValue = this.element.querySelector('select')?.value

    this.fieldTargets.forEach(field => {
      const showWhen = field.dataset.showWhen
      
      if (showWhen === selectedValue) {
        field.style.display = "flex"
        field.querySelectorAll('input, select, textarea').forEach(input => {
          input.disabled = false
        })
      } else {
        field.style.display = "none"
        field.querySelectorAll('input, select, textarea').forEach(input => {
          input.disabled = true
        })
      }
    })
  }

  // Called when the trigger select changes
  triggerChanged(event) {
    this.showHideFields()
  }
}
