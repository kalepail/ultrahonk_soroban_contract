/**
 * StellarService - Handles interaction with Stellar blockchain for proof verification
 *
 * This service provides methods to submit UltraHonk proofs to a Stellar/Soroban smart contract
 * for on-chain verification. It manages transaction signing, submission, and result extraction.
 */

import { Client } from 'ultrahonk-soroban-contract-sdk';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

/**
 * Result of a proof verification transaction on Stellar
 */
export interface VerificationResult {
  /** Whether the verification transaction succeeded */
  success: boolean;
  /** Hex-encoded Keccak-256 hash of the proof blob */
  proofId: string;
  /** Stellar transaction hash */
  txHash?: string;
  /** Whether the proof is verified on-chain (from is_verified query) */
  isVerified: boolean;
  /** CPU instructions consumed by the verification (from simulation) */
  cpuInstructions?: number;
  /** Transaction fee in stroops */
  fee?: string;
  /** Error message if verification failed */
  error?: string;
}

/**
 * Service for interacting with Stellar blockchain to verify UltraHonk proofs
 */
export class StellarService {
  private client: Client;
  private keypair: Keypair;
  private rpcUrl: string;

  /**
   * Creates a new StellarService instance
   *
   * @param contractId - Stellar contract ID for the UltraHonk verifier (C-prefixed address)
   * @param rpcUrl - Stellar RPC endpoint URL
   * @param secretKey - Optional secret key for signing transactions (defaults to alice's key)
   */
  constructor(
    contractId: string = 'CCGOTRYRB6R3E6OY2XQAVQGM2T3URVQERFXQGU7HJEMONY7DU3UUCPOQ',
    rpcUrl: string = 'https://noir-local.stellar.buzz/soroban/rpc',
    secretKey?: string
  ) {
    this.rpcUrl = rpcUrl;

    // Initialize keypair - use alice's key or provided key
    if (secretKey) {
      this.keypair = Keypair.fromSecret(secretKey);
    } else {
      // Default alice keypair for local network
      this.keypair = Keypair.fromSecret(
        'SDBXWELRSGKFPM3J367XJFMG3CU5NQJYFJMYCMIBTTMCAYKEX5EVSWKA'
      );
    }

    // Initialize client
    this.client = new Client({
      contractId,
      networkPassphrase: 'Standalone Network ; February 2017',
      rpcUrl: this.rpcUrl,
      publicKey: this.keypair.publicKey(),
      allowHttp: true, // Allow HTTP for local development
    });
  }

  /**
   * Submits an UltraHonk proof to Stellar for on-chain verification
   *
   * This method:
   * 1. Calls the verify_proof contract method with the VK and proof blob
   * 2. Extracts CPU instructions from the simulation data
   * 3. Signs and submits the transaction
   * 4. Extracts the fee from the transaction result
   * 5. Queries is_verified to confirm the proof was stored correctly
   *
   * @param vkJson - Verification key as raw bytes (from bb write_vk --oracle_hash keccak)
   * @param proofBlob - Proof blob containing: u32_be(total_fields) || public_inputs || proof
   * @param proofId - Hex-encoded Keccak-256 hash of the proof blob
   * @returns Verification result including transaction hash, fee, CPU instructions, and verification status
   */
  async verifyProof(
    vkJson: Uint8Array,
    proofBlob: Uint8Array,
    proofId: string
  ): Promise<VerificationResult> {
    try {
      console.log('[StellarService] Calling verify_proof...');
      console.log(`[StellarService] VK size: ${vkJson.length} bytes`);
      console.log(`[StellarService] Proof blob size: ${proofBlob.length} bytes`);

      // Convert Uint8Array to Buffer
      const vkBuffer = Buffer.from(vkJson);
      const proofBuffer = Buffer.from(proofBlob);

      // Initialize variables for result data
      let cpuInstructions: number | undefined;
      let fee: string | undefined;

      // Call verify_proof
      const tx = await this.client.verify_proof({
        vk_json: vkBuffer,
        proof_blob: proofBuffer,
      });

      console.log('[StellarService] Transaction assembled, signing and sending...');

      // Extract CPU instructions from simulation (following bunt pattern)
      const simulation = (tx as any).simulation;
      if (simulation && 'transactionData' in simulation) {
        const txData = simulation.transactionData as any;
        if (txData && txData._data && txData._data._attributes && txData._data._attributes.resources) {
          const resources = txData._data._attributes.resources;
          if (resources._attributes && 'instructions' in resources._attributes) {
            cpuInstructions = parseInt(resources._attributes.instructions.toString());
            console.log('[StellarService] CPU Instructions from simulation:', cpuInstructions);
          }
        }
      }

      // Sign and send transaction
      const result = await tx.signAndSend({
        signTransaction: async (xdr: string) => {
          const transaction = TransactionBuilder.fromXDR(xdr, this.client.options.networkPassphrase);
          transaction.sign(this.keypair);
          return {
            signedTxXdr: transaction.toXDR(),
            signerAddress: this.keypair.publicKey(),
          };
        },
      });

      console.log('[StellarService] Transaction sent');

      // Get transaction hash from result
      const txHash = (result as any).hash || '';

      // Extract fee charged from transaction response (following bunt pattern)
      const txResponse = result.getTransactionResponse;
      if (txResponse && txResponse.status === 'SUCCESS') {
        fee = txResponse.resultXdr.feeCharged().toString();
        console.log('[StellarService] Fee charged:', fee, 'stroops');
      }

      console.log('[StellarService] verify_proof succeeded');
      if (cpuInstructions) {
        console.log(`[StellarService] CPU Instructions: ${cpuInstructions.toLocaleString()}`);
      }
      if (fee) {
        const stroops = parseInt(fee);
        const xlm = (stroops / 10_000_000).toFixed(7);
        console.log(`[StellarService] Fee: ${stroops.toLocaleString()} stroops (${xlm} XLM)`);
      }

      // Now check if verified (read-only call, no signing needed)
      console.log('[StellarService] Calling is_verified...');
      const proofIdBuffer = Buffer.from(proofId, 'hex');
      const isVerifiedTx = await this.client.is_verified({
        proof_id: proofIdBuffer,
      });

      console.log('[StellarService] is_verified result:', isVerifiedTx.result);
      const isVerified = isVerifiedTx.result === true;

      return {
        success: true,
        proofId,
        txHash,
        isVerified,
        cpuInstructions,
        fee,
      };
    } catch (error: any) {
      console.error('[StellarService] Error:', error);
      return {
        success: false,
        proofId,
        isVerified: false,
        error: error.message || String(error),
      };
    }
  }
}
