# frozen_string_literal: true

class StreamingAssistantResponseJob < ApplicationJob
  queue_as :high_priority

  # Performs streaming AI response generation
  # Broadcasts real-time text deltas via Action Cable
  #
  # @param message_id [String] The user message ID to respond to
  def perform(message_id)
    message = Message.find(message_id)
    chat = message.chat
    user = chat.user

    Rails.logger.info("StreamingAssistantResponseJob: Starting for message #{message_id}, chat #{chat.id}")

    # Create assistant message upfront (empty content)
    assistant_message = AssistantMessage.create!(
      chat: chat,
      content: "",
      ai_model: message.ai_model,
      status: :pending
    )

    # Broadcast initial message creation
    ChatStreamingChannel.broadcast_to(chat, {
      type: "message_created",
      message_id: assistant_message.id,
      timestamp: Time.current.iso8601
    })

    begin
      # Get assistant and stream response
      assistant = chat.assistant

      # Enhanced responder with streaming support
      assistant.respond_streaming(message) do |event|
        handle_stream_event(event, assistant_message, chat)
      end

      Rails.logger.info("StreamingAssistantResponseJob: Completed for message #{message_id}")

    rescue => e
      Rails.logger.error("StreamingAssistantResponseJob: Error for message #{message_id}: #{e.message}")
      Rails.logger.error(e.backtrace.join("\n"))

      # Mark message as failed
      assistant_message.update!(status: :failed)

      # Broadcast error
      ChatStreamingChannel.broadcast_to(chat, {
        type: "error",
        message_id: assistant_message.id,
        error: e.message,
        timestamp: Time.current.iso8601
      })

      # Add error to chat
      chat.add_error(e)
    end
  end

  private

    def handle_stream_event(event, assistant_message, chat)
      case event[:type]
      when :text_delta
        # Append to message content
        assistant_message.content += event[:content]
        assistant_message.save!

        # Broadcast text delta via Action Cable
        ChatStreamingChannel.broadcast_to(chat, {
          type: "text_delta",
          message_id: assistant_message.id,
          content: event[:content],
          timestamp: Time.current.iso8601
        })

      when :tool_calls
        # Handle function calling
        Rails.logger.info("StreamingAssistantResponseJob: Tool calls received for message #{assistant_message.id}")

        # Broadcast tool calls event
        ChatStreamingChannel.broadcast_to(chat, {
          type: "tool_calls",
          message_id: assistant_message.id,
          tool_calls: event[:tool_calls],
          timestamp: Time.current.iso8601
        })

      when :complete
        # Mark message as complete
        assistant_message.update!(status: :complete)

        # Update chat with response ID
        if event[:response_id]
          chat.update_latest_response!(event[:response_id])
        end

        # Broadcast completion
        ChatStreamingChannel.broadcast_to(chat, {
          type: "complete",
          message_id: assistant_message.id,
          usage: event[:usage],
          finish_reason: event[:finish_reason],
          timestamp: Time.current.iso8601
        })

        Rails.logger.info("StreamingAssistantResponseJob: Streaming complete for message #{assistant_message.id}")

      when :error
        # Handle streaming error
        Rails.logger.error("StreamingAssistantResponseJob: Streaming error for message #{assistant_message.id}: #{event[:error]}")

        assistant_message.update!(status: :failed)

        ChatStreamingChannel.broadcast_to(chat, {
          type: "error",
          message_id: assistant_message.id,
          error: event[:error].message,
          timestamp: Time.current.iso8601
        })
      end
    end
end
