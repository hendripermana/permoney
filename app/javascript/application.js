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

// Rails 8.1 - No need to intercept turbo:click
// Turbo handles link clicks automatically based on data-turbo-frame attributes

// Rails 8.1 - Enhanced Turbo Drive configuration
// Progress bar is handled automatically by Turbo
