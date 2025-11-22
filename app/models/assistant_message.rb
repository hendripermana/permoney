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
      # Use Turbo Stream morphing for smooth real-time updates
      Turbo::StreamsChannel.broadcast_action_to(
        chat,
        action: :replace,
        target: dom_id(self),
        attributes: { method: "morph" },
        partial: "assistant_messages/assistant_message",
        locals: { assistant_message: self }
      )
    end
end
