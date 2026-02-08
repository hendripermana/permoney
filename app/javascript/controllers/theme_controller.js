import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["icon"]

  connect() {
    this.updateTheme(this.currentTheme)
  }

  toggle() {
    const newTheme = this.currentTheme === "dark" ? "light" : "dark"
    this.updateTheme(newTheme)
  }

  updateTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme)
    localStorage.setItem("theme", theme)
    
    // Update icons if targets exist
    if (this.hasIconTarget) {
      // Logic to switch icon if needed, but we might just use CSS
    }
    
    // Dispatch event for other components
    window.dispatchEvent(new CustomEvent("theme:change", { detail: { theme } }))
  }

  get currentTheme() {
    return localStorage.getItem("theme") || 
           (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  }
}
