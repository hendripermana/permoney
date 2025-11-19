// Rails 8.1: Profile Image Preview Controller with F1-level performance optimization
// Handles instant preview of uploaded avatar images with proper memory management
import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = [
    "attachedImage",
    "previewImage",
    "placeholderImage",
    "deleteProfileImage",
    "input",
    "clearBtn",
    "uploadText",
    "changeText",
    "cameraIcon",
  ];

  // Store blob URL for cleanup
  #currentBlobUrl = null;

  // Cleanup on disconnect to prevent memory leaks
  disconnect() {
    this.#revokeBlobUrl();
  }

  clearFileInput() {
    // Revoke previous blob URL to prevent memory leaks
    this.#revokeBlobUrl();

    this.inputTarget.value = null;
    this.clearBtnTarget.classList.add("hidden");
    this.placeholderImageTarget.classList.remove("hidden");
    this.attachedImageTarget.classList.add("hidden");
    this.previewImageTarget.classList.add("hidden");
    this.deleteProfileImageTarget.value = "1";
    this.uploadTextTarget.classList.remove("hidden");
    this.changeTextTarget.classList.add("hidden");
    this.changeTextTarget.setAttribute("aria-hidden", "true");
    this.uploadTextTarget.setAttribute("aria-hidden", "false");
    this.cameraIconTarget.classList.remove("!hidden");
  }

  showFileInputPreview(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type and size
    if (!this.#validateFile(file)) {
      this.inputTarget.value = null;
      return;
    }

    // Revoke previous blob URL to prevent memory leaks
    this.#revokeBlobUrl();

    // Show preview with smooth transition
    this.placeholderImageTarget.classList.add("hidden");
    this.attachedImageTarget.classList.add("hidden");
    this.previewImageTarget.classList.remove("hidden");
    this.clearBtnTarget.classList.remove("hidden");
    this.deleteProfileImageTarget.value = "0";
    this.uploadTextTarget.classList.add("hidden");
    this.changeTextTarget.classList.remove("hidden");
    this.changeTextTarget.setAttribute("aria-hidden", "false");
    this.uploadTextTarget.setAttribute("aria-hidden", "true");
    this.cameraIconTarget.classList.add("!hidden");

    // Create and store new blob URL
    this.#currentBlobUrl = URL.createObjectURL(file);
    const img = this.previewImageTarget.querySelector("img");
    img.src = this.#currentBlobUrl;
    img.alt = `Preview of ${file.name}`;
  }

  // Private methods
  #validateFile(file) {
    const validTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    const maxSize = 5 * 1024 * 1024; // 5MB

    if (!validTypes.includes(file.type)) {
      alert("Please select a valid image file (JPEG, PNG, or WebP)");
      return false;
    }

    if (file.size > maxSize) {
      alert("Image size must be less than 5MB");
      return false;
    }

    return true;
  }

  #revokeBlobUrl() {
    if (this.#currentBlobUrl) {
      URL.revokeObjectURL(this.#currentBlobUrl);
      this.#currentBlobUrl = null;
    }
  }
}
