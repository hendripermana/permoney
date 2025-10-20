# frozen_string_literal: true

class FloatingChatComponent < ApplicationComponent
  def initialize(user:, **options)
    @user = user
    @options = options
  end

  def chat
    @chat ||= @user.last_viewed_chat || @user.chats.order(created_at: :desc).first
  end

  def new_chat?
    chat.nil?
  end
end
