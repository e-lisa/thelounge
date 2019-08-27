"use strict";

const socket = require("./socket");
const updateCursor = require("undate").update;

class Uploader {
	init() {
		this.vueApp = require("./vue").vueApp;
		this.xhr = null;
		this.fileQueue = [];
		this.overlay = document.getElementById("upload-overlay");
		this.uploadInput = document.getElementById("upload-input");
		this.uploadProgressbar = document.getElementById("upload-progressbar");

		this.uploadInput.addEventListener("change", (e) => this.filesChanged(e));
		document.addEventListener("dragenter", (e) => this.dragEnter(e));
		document.addEventListener("dragover", (e) => this.dragOver(e));
		document.addEventListener("dragleave", (e) => this.dragLeave(e));
		document.addEventListener("drop", (e) => this.drop(e));
		document.addEventListener("paste", (e) => this.paste(e));

		socket.on("upload:auth", (token) => this.uploadNextFileInQueue(token));
	}

	dragOver(event) {
		// Prevent dragover event completely and do nothing with it
		// This stops the browser from trying to guess which cursor to show
		event.preventDefault();
	}

	dragEnter(event) {
		event.preventDefault();

		// relatedTarget is the target where we entered the drag from
		// when dragging from another window, the target is null, otherwise its a DOM element
		if (!event.relatedTarget && event.dataTransfer.types.includes("Files")) {
			this.overlay.classList.add("is-dragover");
		}
	}

	dragLeave(event) {
		event.preventDefault();

		// If relatedTarget is null, that means we are no longer dragging over the page
		if (!event.relatedTarget) {
			this.overlay.classList.remove("is-dragover");
		}
	}

	drop(event) {
		event.preventDefault();
		this.overlay.classList.remove("is-dragover");

		let files;

		if (event.dataTransfer.items) {
			files = Array.from(event.dataTransfer.items)
				.filter((item) => item.kind === "file")
				.map((item) => item.getAsFile());
		} else {
			files = Array.from(event.dataTransfer.files);
		}

		this.triggerUpload(files);
	}

	paste(event) {
		const items = event.clipboardData.items;
		const files = [];

		for (const item of items) {
			if (item.kind === "file") {
				files.push(item.getAsFile());
			}
		}

		if (files.length === 0) {
			return;
		}

		event.preventDefault();
		this.triggerUpload(files);
	}

	filesChanged() {
		const files = Array.from(this.uploadInput.files);
		this.triggerUpload(files);
		this.uploadInput.value = ""; // Reset <input> element so you can upload the same file
	}

	triggerUpload(files) {
		if (!files.length) {
			return;
		}

		if (!this.vueApp.isConnected) {
			this.handleResponse({
				error: `You are currently disconnected, unable to initiate upload process.`,
			});

			return;
		}

		const wasQueueEmpty = this.fileQueue.length === 0;

		for (const file of files) {
			if (this.maxFileSize > 0 && file.size > this.maxFileSize) {
				this.handleResponse({
					error: `File ${file.name} is over the maximum allowed size`,
				});

				continue;
			}

			this.fileQueue.push(file);
		}

		// if the queue was empty and we added some files to it, and there currently
		// is no upload in process, request a token to start the upload process
		if (wasQueueEmpty && this.xhr === null && this.fileQueue.length > 0) {
			this.requestToken();
		}
	}

	requestToken() {
		socket.emit("upload:auth");
	}

	setProgress(value) {
		this.uploadProgressbar.classList.toggle("upload-progressbar-visible", value > 0);
		this.uploadProgressbar.style.width = value + "%";
	}

	uploadNextFileInQueue(token) {
		const file = this.fileQueue.shift();
		this.xhr = new XMLHttpRequest();

		this.xhr.upload.addEventListener(
			"progress",
			(e) => {
				const percent = Math.floor((e.loaded / e.total) * 1000) / 10;
				this.setProgress(percent);
			},
			false
		);

		this.xhr.onreadystatechange = () => {
			if (this.xhr.readyState === XMLHttpRequest.DONE) {
				let response;

				try {
					response = JSON.parse(this.xhr.responseText);
				} catch (err) {
					// This is just a safe guard and should not happen if server doesn't throw any errors.
					// Browsers break the HTTP spec by aborting the request without reading any response data,
					// if there is still data to be uploaded. Servers will only error in extreme cases like bad
					// authentication or server-side errors.
					response = {
						error: `Upload aborted: HTTP ${this.xhr.status}`,
					};
				}

				this.handleResponse(response);

				this.xhr = null;

				// this file was processed, if we still have files in the queue, upload the next one
				if (this.fileQueue.length > 0) {
					this.requestToken();
				}
			}
		};

		const formData = new FormData();
		formData.append("file", file);
		this.xhr.open("POST", `uploads/new/${token}`);
		this.xhr.send(formData);
	}

	handleResponse(response) {
		this.setProgress(0);

		if (response.error) {
			// require here due to circular dependency
			const {vueApp} = require("./vue");
			vueApp.currentUserVisibleError = response.error;
			return;
		}

		if (response.url) {
			this.insertUploadUrl(response.url);
		}
	}

	insertUploadUrl(url) {
		const fullURL = new URL(url, location).toString();
		const textbox = document.getElementById("input");
		const initStart = textbox.selectionStart;

		// Get the text before the cursor, and add a space if it's not in the beginning
		const headToCursor = initStart > 0 ? textbox.value.substr(0, initStart) + " " : "";

		// Get the remaining text after the cursor
		const cursorToTail = textbox.value.substr(initStart);

		// Construct the value until the point where we want the cursor to be
		const textBeforeTail = headToCursor + fullURL + " ";

		updateCursor(textbox, textBeforeTail + cursorToTail);

		// Set the cursor after the link and a space
		textbox.selectionStart = textbox.selectionEnd = textBeforeTail.length;
	}

	// TODO: This is a temporary hack while Vue porting is finalized
	abort() {
		this.fileQueue = [];

		if (this.xhr) {
			this.xhr.abort();
			this.xhr = null;
		}
	}
}

const instance = new Uploader();

function initialize() {
	instance.init();
	return instance;
}

/**
 * Called in the `configuration` socket event.
 * Makes it so the user can be notified if a file is too large without waiting for the upload to finish server-side.
 **/
function setMaxFileSize(kb) {
	instance.maxFileSize = kb;
}

module.exports = {
	abort: () => instance.abort(),
	initialize,
	setMaxFileSize,
};
