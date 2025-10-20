class MessagesController < ApplicationController
  guard_feature unless: -> { Current.user.ai_enabled? }

  before_action :set_chat

  def create
    @message = @chat.messages.build(message_params)

    if @message.save
      if turbo_frame_request?
        @message = UserMessage.new(chat: @chat)
        render "chats/floating_show", layout: false
      else
        redirect_to chat_redirect_path
      end
    else
      if turbo_frame_request?
        render "chats/floating_show", layout: false, status: :unprocessable_entity
      else
        flash.now[:alert] = @message.errors.full_messages.to_sentence
        render "chats/show", status: :unprocessable_entity
      end
    end
  end

  private
    def set_chat
      @chat = Current.user.chats.find(params[:chat_id])
    end

    def message_params
      params.require(:message).permit(:content, :ai_model)
    end

    def floating_request?
      params[:floating].present?
    end

    def chat_redirect_path
      options = { thinking: true }
      options[:floating] = true if floating_request?
      chat_path(@chat, options)
    end
end
