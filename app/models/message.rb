class Message < ApplicationRecord
  belongs_to :chat
  has_many :tool_calls, dependent: :destroy

  enum :status, {
    pending: "pending",
    complete: "complete",
    failed: "failed"
  }

  validates :content, presence: true

  after_create_commit -> { broadcast_append_to chat, target: "messages" }, if: :broadcast?
  # Default to update, but AssistantMessage will override for morphing
  after_update_commit -> { broadcast_update_to chat }, if: :broadcast_update?

  scope :ordered, -> { order(created_at: :asc) }

  private
    def broadcast?
      true
    end

    def broadcast_update?
      # Skip for AssistantMessage as it has its own morphing implementation
      broadcast? && !is_a?(AssistantMessage)
    end
end
