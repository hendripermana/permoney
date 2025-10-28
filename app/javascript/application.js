// Configure your import map in config/importmap.rb. Read more: https://github.com/rails/importmap-rails
import "@hotwired/turbo-rails";
import "controllers";

// Rails 8.1 - Custom Turbo Stream Actions
Turbo.StreamActions.redirect = function () {
  Turbo.visit(this.target);
};

// Rails 8.1 - Ensure Turbo Frames work correctly with drawer and modal
document.addEventListener("turbo:frame-missing", (event) => {
  // Prevent default error handling for drawer/modal frames
  const { detail } = event;
  const { response } = detail;
  
  if (response.ok) {
    event.preventDefault();
    // Let the server handle the response
    console.log("Turbo frame successfully loaded");
  }
});

// Rails 8.1 - Fix for clickable elements inside Turbo Frames
document.addEventListener("turbo:click", (event) => {
  const { target } = event;
  
  // Ensure links with data-turbo-frame work correctly
  if (target.tagName === "A" && target.dataset.turboFrame) {
    event.stopPropagation();
  }
});

// Rails 8.1 - Enhanced Turbo Drive configuration
Turbo.config.drive.progressBarDelay = 100; // Show progress bar after 100ms
