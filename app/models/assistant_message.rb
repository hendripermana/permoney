class AssistantMessage < Message
  include ActionView::RecordIdentifier

  validates :ai_model, presence: true

  # Override broadcast after update to use morphing for smooth streaming
  after_update_commit -> {
    broadcast_replace_to_with_morph
  }, if: :broadcast?

  def role
    "assistant"
  end

  def append_text!(text)
    self.content += text
    save!
  end

  private

    def broadcast_replace_to_with_morph
      return unless chat.present?

      # Use Turbo Stream morphing for smooth real-time updates
      # Using broadcast_replace_later_to for async, non-blocking updates
      broadcast_replace_later_to(
        chat,
        attributes: { method: :morph },
        partial: "assistant_messages/assistant_message",
        locals: { assistant_message: self }
      )
    end
end
