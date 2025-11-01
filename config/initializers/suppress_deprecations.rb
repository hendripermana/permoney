# frozen_string_literal: true

# Temporary suppression of ActiveSupport::Configurable deprecation warning
# This deprecation comes from gem dependencies (likely rails-settings-cached or langfuse-ruby)
# that haven't updated to Rails 8.1 yet.
#
# Root cause: ActiveSupport::Configurable is deprecated in Rails 8.1 and will be removed in 8.2
# Solution path:
#   1. Monitor gem updates for rails-settings-cached and other dependencies
#   2. Once gems are updated, remove this suppressor
#   3. If gems are abandoned, consider alternatives
#
# Reference: Rails 8.1 Deprecation Warnings
# TODO: Remove this file when dependencies are updated
#
# Last checked: 2025-11-02
# Rails version: 8.1.1

# Note: In Rails 8.1, we cannot fully suppress deprecations, but we can document them
# The warning will still appear during boot, but this documents why and what to do
# 
# Current status: Tracking gem updates
# - rails-settings-cached: Check for Rails 8.1 compatibility
# - langfuse-ruby: Check for Rails 8.1 compatibility
#
# For now, the warning is harmless and does not affect functionality.
