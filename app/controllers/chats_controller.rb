class ChatsController < ApplicationController
  include ActionView::RecordIdentifier

  before_action :set_chat, only: [ :show, :edit, :update, :destroy, :retry ]

  def index
    @chats = Current.user.chats.order(created_at: :desc)
  end

  def show
    set_last_viewed_chat(@chat)
    @message ||= UserMessage.new(chat: @chat)

    if params[:floating]
      render "chats/floating_show", layout: false
    end
  end

  def new
    @chat = Current.user.chats.new(title: "New chat #{Time.current.strftime("%Y-%m-%d %H:%M")}")

    if params[:floating]
      render "chats/floating_new", layout: false
    end
  end

  def create
    begin
      @chat = Current.user.chats.start!(chat_params[:content], model: chat_params[:ai_model])
      set_last_viewed_chat(@chat)
    rescue => e
      # If chat creation fails (e.g. API error), we might not have a persisted chat.
      # But chats.start! creates the chat first.
      # If start! fails during creation, @chat might be nil or invalid.
      # We need to handle that.
      Rails.logger.error("Chat creation failed: #{e.message}")
      if @chat&.persisted?
        @chat.add_error(e.message)
      else
        if turbo_frame_request?
          flash.now[:alert] = "Failed to start chat: #{e.message}"
          render "chats/floating_new", layout: false, status: :unprocessable_entity
          return
        else
          flash[:alert] = "Failed to start chat: #{e.message}"
          redirect_to chats_path and return
        end
      end
    end

    if turbo_frame_request?
      @message = UserMessage.new(chat: @chat)
      render "chats/floating_show", layout: false
    else
      redirect_to chat_redirect_path
    end
  end

  def edit
  end

  def update
    @chat.update!(chat_params)

    respond_to do |format|
      format.html { redirect_back_or_to chat_path(@chat), notice: "Chat updated" }
      format.turbo_stream { render turbo_stream: turbo_stream.replace(dom_id(@chat, :title), partial: "chats/chat_title", locals: { chat: @chat }) }
    end
  end

  def destroy
    @chat.destroy
    clear_last_viewed_chat

    redirect_to chats_path, notice: "Chat was successfully deleted"
  end

  def retry
    begin
      @chat.retry_last_message!
    rescue => e
      Rails.logger.error("Chat retry failed: #{e.message}")
      @chat.add_error(e.message)
    end

    @message ||= UserMessage.new(chat: @chat)
    if turbo_frame_request?
      render "chats/floating_show", layout: false
    else
      redirect_to chat_redirect_path
    end
  end

  private
    def set_chat
      @chat = Current.user.chats.find(params[:id])
    end

    def set_last_viewed_chat(chat)
      Current.user.update!(last_viewed_chat: chat)
    end

    def clear_last_viewed_chat
      Current.user.update!(last_viewed_chat: nil)
    end

    def chat_params
      params.require(:chat).permit(:title, :content, :ai_model)
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
