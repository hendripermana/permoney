# frozen_string_literal: true

# Be sure to restart your server when you modify this file.
#
# This file eases your Rails 8.1 framework defaults upgrade.
#
# Uncomment each configuration one by one to switch to the new default.
# Once your application is ready to run with all new defaults, you can remove
# this file and set the `config.load_defaults` to `8.1`.
#
# Read the documentation for more information on each configuration option.
# https://guides.rubyonrails.org/configuring.html
# https://guides.rubyonrails.org/8_1_release_notes.html

# Rails 8.1 new defaults

# Active Record Encryption now uses SHA-256 as its hash digest algorithm
# Rails.application.config.active_record.encryption.hash_digest_class = OpenSSL::Digest::SHA256

# Enable Active Record Continuations for long-running jobs
# Allows breaking jobs into discrete steps for better resilience
# Rails.application.config.active_job.use_big_decimal_serialize = true

# Enable Structured Event Reporting for better logging and monitoring
# Rails.application.config.active_support.report_deprecations = true

# Schema dumper now sorts columns alphabetically by default
Rails.application.config.active_record.schema_format_version = 8.1
