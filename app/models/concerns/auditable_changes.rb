module AuditableChanges
  extend ActiveSupport::Concern

  included do
    class_attribute :auditable_fields, instance_writer: false, default: []

    after_commit :record_audit_log_for_tracked_changes, on: :update
  end

  class_methods do
    def track_changes_for(*fields)
      self.auditable_fields = fields.map(&:to_s)
    end
  end

  private
    def record_audit_log_for_tracked_changes
      return if auditable_fields.blank?

      changed = previous_changes.slice(*auditable_fields)
      return if changed.blank?

      AuditLog.create!(
        auditable_type: self.class.name,
        auditable_id: id,
        event: "update",
        changeset: changed,
        user_id: Current.user&.id,
        ip_address: Current.ip_address
      )
    rescue => e
      Rails.logger.error({ at: "AuditableChanges.record_audit_log", model: self.class.name, id: id, error: e.message }.to_json)
    end
end
