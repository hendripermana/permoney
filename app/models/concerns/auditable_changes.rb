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

    def track_changes_for_fields
      auditable_fields.map(&:to_sym)
    end
  end

  private
    def record_audit_log_for_tracked_changes
      return if auditable_fields.blank?

      raw_changes = previous_changes.slice(*auditable_fields)

      changed = raw_changes.reject do |field, values|
        next true unless values.is_a?(Array)

        before, after = values
        next true if normalized_change_value(before) == normalized_change_value(after)
        next true unless audit_change_allowed?(field, before, after)

        false
      end
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

    def normalized_change_value(value)
      case value
      when BigDecimal
        value.to_s("F")
      when Money
        [ value.currency&.iso_code, value.cents ]
      else
        value
      end
    end

    def audit_change_allowed?(_field, _before, _after)
      true
    end
end
