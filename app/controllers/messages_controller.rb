class MessagesController < ApplicationController
  guard_feature unless: -> { Current.user.ai_enabled? }

  before_action :set_chat

  def create
    @message = UserMessage.new(
      chat: @chat,
      content: message_params[:content],
      ai_model: message_params[:ai_model].presence || Chat.default_model
    )

    if @message.save
      respond_to_success
    else
      respond_to_failure
    end
  end

  private
    def set_chat
      @chat = Current.user.chats.find(params[:chat_id])
    end

    def message_params
      params.require(:message).permit(:content, :ai_model)
    end

    def respond_to_success
      if floating_request?
        @message = UserMessage.new(chat: @chat)
        render "chats/floating_show", layout: false
      else
        redirect_to chat_path(@chat, thinking: true)
      end
    end

    def respond_to_failure
      if floating_request?
        render "chats/floating_show", layout: false, status: :unprocessable_entity
      else
        render "chats/show", status: :unprocessable_entity
      end
    end

    def floating_request?
      params[:floating].present? || turbo_frame_request?
    end
end
