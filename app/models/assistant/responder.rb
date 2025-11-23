class Assistant::Responder
  def initialize(message:, instructions:, function_tool_caller:, llm:)
    @message = message
    @instructions = instructions
    @function_tool_caller = function_tool_caller
    @llm = llm
  end

  def on(event_name, &block)
    listeners[event_name.to_sym] << block
  end

  def respond(previous_response_id: nil)
    # Track whether response was handled by streamer
    response_handled = false

    # For the first response
    streamer = proc do |chunk|
      case chunk.type
      when "output_text"
        emit(:output_text, chunk.data)
      when "response"
        response = chunk.data
        response_handled = true

        if response.function_requests.any?
          handle_follow_up_response(response)
        else
          emit(:response, { id: response.id })
        end
      end
    end

    response = get_llm_response(streamer: streamer, previous_response_id: previous_response_id)

    # For synchronous (non-streaming) responses, handle function requests if not already handled by streamer
    unless response_handled
      if response && response.function_requests.any?
        handle_follow_up_response(response)
      elsif response
        emit(:response, { id: response.id })
      end
    end
  end

  # New streaming method using Provider::Openai::StreamingChat
  # Yields events to caller for real-time processing
  def respond_streaming(&progress_block)
    raise ArgumentError, "Block required for streaming" unless block_given?

    # Build messages array in standard OpenAI format
    messages = build_messages_array

    # Build tools array for function calling
    tools = build_tools_array

    # Create streaming wrapper
    streaming_chat = Provider::Openai::StreamingChat.new(
      client: @llm.client,
      model: message.ai_model,
      messages: messages,
      tools: tools,
      custom_provider: @llm.custom_provider?
    )

    accumulated_content = ""
    response_id = nil
    usage = nil
    tool_calls = nil

    # Stream with progress callbacks
    streaming_chat.stream do |event|
      case event[:type]
      when :text_delta
        accumulated_content += event[:content]
        progress_block.call({
          type: :text_delta,
          content: event[:content],
          message_id: event[:message_id]
        })

      when :tool_calls
        # Handle function calling (future enhancement)
        tool_calls = event[:tool_calls]
        progress_block.call({
          type: :tool_calls,
          tool_calls: tool_calls
        })

      when :complete
        response_id = event[:response_id]
        usage = event[:usage]
        tool_calls = event[:tool_calls]

        # If there are tool calls, handle them
        if tool_calls && tool_calls.any?
          handle_streaming_function_calls(tool_calls, response_id, &progress_block)
        else
          progress_block.call({
            type: :complete,
            content: accumulated_content,
            response_id: response_id,
            usage: usage,
            finish_reason: event[:finish_reason]
          })
        end

      when :error
        progress_block.call({
          type: :error,
          error: event[:error]
        })
      end
    end

    # Return final response data
    {
      content: accumulated_content,
      response_id: response_id,
      usage: usage,
      tool_calls: tool_calls
    }
  end

  private
    attr_reader :message, :instructions, :function_tool_caller, :llm

    def handle_follow_up_response(response)
      streamer = proc do |chunk|
        case chunk.type
        when "output_text"
          emit(:output_text, chunk.data)
        when "response"
          # We do not currently support function executions for a follow-up response (avoid recursive LLM calls that could lead to high spend)
          emit(:response, { id: chunk.data.id })
        end
      end

      function_tool_calls = function_tool_caller.fulfill_requests(response.function_requests)

      emit(:response, {
        id: response.id,
        function_tool_calls: function_tool_calls
      })

      # Get follow-up response with tool call results
      get_llm_response(
        streamer: streamer,
        function_results: function_tool_calls.map(&:to_result),
        previous_response_id: response.id
      )
    end

    def get_llm_response(streamer:, function_results: [], previous_response_id: nil)
      response = llm.chat_response(
        message.content,
        model: message.ai_model,
        instructions: instructions,
        functions: function_tool_caller.function_definitions,
        function_results: function_results,
        streamer: streamer,
        previous_response_id: previous_response_id,
        session_id: chat_session_id,
        user_identifier: chat_user_identifier,
        family: message.chat&.user&.family
      )

      unless response.success?
        raise response.error
      end

      response.data
    end

    def emit(event_name, payload = nil)
      listeners[event_name.to_sym].each { |block| block.call(payload) }
    end

    def listeners
      @listeners ||= Hash.new { |h, k| h[k] = [] }
    end

    def chat_session_id
      chat&.id&.to_s
    end

    def chat_user_identifier
      return unless chat&.user_id

      ::Digest::SHA256.hexdigest(chat.user_id.to_s)
    end

    def chat
      @chat ||= message.chat
    end

    # Build messages array in standard OpenAI format
    def build_messages_array
      messages = []

      # Add system message if instructions present
      if @instructions.present?
        messages << { role: "system", content: @instructions }
      end

      # Add user message
      messages << { role: "user", content: message.content }

      # TODO: Add conversation history if needed
      # messages += build_conversation_history

      messages
    end

    # Build tools array for function calling
    def build_tools_array
      return [] if function_tool_caller.function_definitions.blank?

      function_tool_caller.function_definitions.map do |fn|
        {
          type: "function",
          function: {
            name: fn[:name],
            description: fn[:description],
            parameters: fn[:params_schema]
          }
        }
      end
    end

    # Handle function calls during streaming (future enhancement)
    def handle_streaming_function_calls(tool_calls, response_id, &progress_block)
      # Parse tool calls
      function_requests = tool_calls.map do |tool_call|
        {
          id: tool_call["id"],
          name: tool_call["function"]["name"],
          arguments: tool_call["function"]["arguments"]
        }
      end

      # Execute functions
      function_results = function_tool_caller.fulfill_requests(function_requests)

      # Notify about function execution
      progress_block.call({
        type: :functions_executed,
        function_results: function_results
      })

      # TODO: Make follow-up streaming call with function results
      # For now, just mark as complete
      progress_block.call({
        type: :complete,
        response_id: response_id,
        function_calls_executed: true
      })
    end
end
