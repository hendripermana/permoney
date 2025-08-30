// Temporary stub to avoid Stimulus loader errors when eagerly loading controllers
import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  connect() {
    // No-op: controller not used in development; prevents undefined shouldLoad error
  }
}