# frozen_string_literal: true

class ChatStreamingChannel < ApplicationCable::Channel
  # Real-time streaming channel for AI chat responses
  # Handles:
  # - Streaming text deltas from LLM
  # - Stop generation command
  # - Connection lifecycle
  #
  # Client subscribes with: { channel: "ChatStreamingChannel", chat_id: "123" }

  def subscribed
    # Verify user owns the chat
    chat = current_user.chats.find_by(id: params[:chat_id])

    if chat
      stream_for chat
      @chat = chat
      @generation_active = false

      Rails.logger.info("ChatStreamingChannel: User #{current_user.id} subscribed to chat #{chat.id}")
    else
      Rails.logger.warn("ChatStreamingChannel: User #{current_user.id} attempted to subscribe to unauthorized chat #{params[:chat_id]}")
      reject
    end
  end

  def unsubscribed
    if @generation_active
      Rails.logger.info("ChatStreamingChannel: Stopping generation on disconnect for chat #{@chat&.id}")
      stop_generation
    end
  end

  # Client calls this to stop generation
  def stop_generation
    return unless @chat

    # Signal backend job to stop via Redis cache
    # This prevents wasted API credits and server resources
    stop_key = "chat:#{@chat.id}:stop_generation"
    Rails.cache.write(stop_key, true, expires_in: 1.minute)

    @generation_active = false

    # Broadcast stop event to all subscribers
    ChatStreamingChannel.broadcast_to(@chat, {
      type: "generation_stopped",
      timestamp: Time.current.iso8601
    })

    Rails.logger.info("ChatStreamingChannel: Generation stopped for chat #{@chat.id} (backend job will terminate)")
  end

  # Mark generation as active (called from job)
  def mark_generation_active
    @generation_active = true
  end

  def generation_active?
    @generation_active
  end
end
