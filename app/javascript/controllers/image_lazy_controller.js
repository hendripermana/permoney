import { Controller } from "@hotwired/stimulus"

/**
 * Image Lazy Loading Controller
 * 
 * Implements native browser lazy loading with Intersection Observer fallback
 * Optimizes initial page load by deferring image loading until needed
 * 
 * Usage:
 *   <img data-controller="image-lazy"
 *        data-image-lazy-src-value="path/to/image.jpg"
 *        data-image-lazy-placeholder-value="path/to/placeholder.jpg"
 *        alt="Description"
 *        class="w-full h-auto">
 * 
 * Features:
 * - Native lazy loading with loading="lazy" attribute
 * - Intersection Observer for better control
 * - Smooth fade-in transition on load
 * - Placeholder support for better UX
 */
export default class extends Controller {
  static values = {
    src: String,
    placeholder: String,
    threshold: { type: Number, default: 0 }
  }

  connect() {
    // Set placeholder if provided
    if (this.hasPlaceholderValue) {
      this.element.src = this.placeholderValue
    }

    // Use native lazy loading if supported
    if ("loading" in HTMLImageElement.prototype) {
      this.element.loading = "lazy"
      this.element.src = this.srcValue
      this.setupLoadListener()
    } else {
      // Fallback to Intersection Observer for older browsers
      this.setupIntersectionObserver()
    }
  }

  disconnect() {
    if (this.observer) {
      this.observer.disconnect()
    }
  }

  setupLoadListener() {
    this.element.addEventListener("load", () => {
      this.element.classList.add("loaded")
      this.element.classList.remove("loading")
    }, { once: true })
  }

  setupIntersectionObserver() {
    this.observer = new IntersectionObserver(
      (entries) => this.handleIntersection(entries),
      {
        root: null,
        rootMargin: "50px",
        threshold: this.thresholdValue
      }
    )

    this.observer.observe(this.element)
  }

  handleIntersection(entries) {
    const entry = entries[0]
    
    if (entry.isIntersecting) {
      this.loadImage()
      this.observer.disconnect()
    }
  }

  loadImage() {
    const img = this.element
    
    img.classList.add("loading")
    
    const tempImg = new Image()
    tempImg.onload = () => {
      img.src = this.srcValue
      img.classList.add("loaded")
      img.classList.remove("loading")
    }
    
    tempImg.onerror = () => {
      console.error("Failed to load image:", this.srcValue)
      img.classList.remove("loading")
    }
    
    tempImg.src = this.srcValue
  }
}
