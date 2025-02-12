// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import AudioVideoControllerState from '../audiovideocontroller/AudioVideoControllerState';
import SignalingClient from '../signalingclient/SignalingClient';
import SignalingClientEvent from '../signalingclient/SignalingClientEvent';
import SignalingClientEventType from '../signalingclient/SignalingClientEventType';
import SignalingClientObserver from '../signalingclientobserver/SignalingClientObserver';
import TaskCanceler from '../taskcanceler/TaskCanceler';
import BaseTask from './BaseTask';

export default class CleanStoppedSessionTask extends BaseTask {
  protected taskName = 'CleanStoppedSessionTask';
  private taskCanceler: TaskCanceler | null = null;

  constructor(private context: AudioVideoControllerState) {
    super(context.logger);
  }

  cancel(): void {
    if (this.taskCanceler) {
      this.taskCanceler.cancel();
      this.taskCanceler = null;
    }
  }

  async run(): Promise<void> {
    try {
      if (this.context.signalingClient.ready()) {
        this.context.signalingClient.closeConnection();
        await this.receiveWebSocketClosedEvent();
      }
    } catch (error) {
      throw error;
    } finally {
      for (const observer of this.context.removableObservers) {
        observer.removeObserver();
      }

      this.context.statsCollector.stop();
      this.context.statsCollector = null;
      this.context.connectionMonitor.stop();
      this.context.connectionMonitor = null;

      if (this.context.peer) {
        this.context.peer.close();
      }
      this.context.peer = null;
      this.context.localVideoSender = null;
      this.context.sdpAnswer = null;
      this.context.sdpOfferInit = null;
      this.context.indexFrame = null;
      this.context.videoDownlinkBandwidthPolicy.reset();
      this.context.iceCandidateHandler = null;
      this.context.iceCandidates = [];
      this.context.turnCredentials = null;
      this.context.videoSubscriptions = null;
      this.context.transceiverController.reset();

      // This should really be a _device deselection_ operation,
      // allowing the device controller to clean up any selected transform
      // device or other resources.
      //
      // We can't fix it within the current API because CSST only knows about
      // `MediaStreamBroker`, not about `DeviceController` — it only knows how
      // to // release media streams that are tracked in the
      // `AudioVideoControllerState`, not how to unselect a device.
      //
      // The issue here is that we now work with much more than streams, and
      // this API hasn't kept pace with the complexity of the rest of the SDK.
      //
      // It's currently up to the developer's application to manage which device
      // is currently selected and `DDC` has to figure out from the stream
      // passed here which device to clean up.
      //
      // This can be addressed in a future v3.0.
      this.context.mediaStreamBroker.releaseMediaStream(this.context.activeAudioInput);
      this.context.activeAudioInput = null;
      this.context.mediaStreamBroker.releaseMediaStream(this.context.activeVideoInput);
      this.context.activeVideoInput = null;
      this.context.realtimeController.realtimeSetLocalAudioInput(null);

      const tile = this.context.videoTileController.getLocalVideoTile();
      if (tile) {
        tile.bindVideoStream('', true, null, null, null, null);
      }
      this.context.videoTileController.removeAllVideoTiles();
    }
  }

  private receiveWebSocketClosedEvent(): Promise<void> {
    return new Promise((resolve, reject) => {
      class Interceptor implements SignalingClientObserver, TaskCanceler {
        constructor(private signalingClient: SignalingClient) {}

        cancel(): void {
          this.signalingClient.removeObserver(this);
          reject(
            new Error(
              `CleanStoppedSessionTask got canceled while waiting for the WebSocket closed event`
            )
          );
        }

        handleSignalingClientEvent(event: SignalingClientEvent): void {
          if (event.type === SignalingClientEventType.WebSocketClosed) {
            this.signalingClient.removeObserver(this);
            resolve();
          }
        }
      }

      const interceptor = new Interceptor(this.context.signalingClient);
      this.taskCanceler = interceptor;
      this.context.signalingClient.registerObserver(interceptor);
    });
  }
}
